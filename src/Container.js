"use strict";

import utils from './utils';
import ResolverContext from './ResolverContext';
import InstanceLifecycleType from './InstanceLifecycleType';
import InstanceLifecycle from './InstanceLifecycle';

export default class Container {
    constructor() {
        this._isChildContainer = false;
        this._parent = undefined;
        this._registrations = {};
        this._instanceCache = {};
        this._resolverContext = new ResolverContext();
        this._resolvers = this._createDefaultResolvers();
        this._isDisposed = false;
        this._childContainers = [];
    }
    createChildContainer() {
        if (this._isDisposed) this._throwIsDisposed();
        // The child prototypically inherits some but not all props from its parent.
        // Below we override the ones it doesn't inherit.
        var child = Object.create(this);
        child._parent = this;
        child._isChildContainer = true;
        child._registrations = Object.create(this._registrations);
        child._instanceCache = Object.create(this._instanceCache);
        child._resolvers = Object.create(this._resolvers);
        child._isDisposed = false;
        child._childContainers = [];
        this._childContainers.push(child);
        return child;
    }
    register(name, proto, dependencyList) {
        if (this._isDisposed) this._throwIsDisposed();
        this._validateDependencyList(dependencyList);
        var registration = {
            name: name,
            proto: proto,
            dependencyList: dependencyList,
            instanceLifecycleType: InstanceLifecycleType.singleton
        };
        this._registrations[name] = registration;
        return new InstanceLifecycle(registration, this._instanceCache);
    }
    registerInstance(name, instance) {
        if (this._isDisposed) this._throwIsDisposed();
        var registration = {
            name: name,
            instanceLifecycleType: InstanceLifecycleType.external
        };
        this._registrations[name] = registration;
        this._instanceCache[name] = instance;
    }
    resolve(name) {
        if (this._isDisposed) this._throwIsDisposed();
        var registration = this._registrations[name],
            dependency,
            instance,
            error;
        if (!registration) {
            error = utils.sprintf('Nothing registered for dependency [%s]', name);
            throw new Error(error);
        }
        instance = this._tryRetrieveFromCache(name);
        if (!instance) {
            instance = this._buildInstance(name);
            if (registration.instanceLifecycleType === InstanceLifecycleType.singleton || registration.instanceLifecycleType === InstanceLifecycleType.singletonPerContainer) {
                this._instanceCache[name] = instance;
            }
        }
        return instance;
    }
    addResolver(type, plugin) {
        if (this._isDisposed) this._throwIsDisposed();
        this._resolvers[type] = plugin;
    }
    dispose() {
        this._disposeContainer();
    }
    _tryRetrieveFromCache(name) {
        var registration = this._registrations[name],
            instance = this._instanceCache[name],
            thisContainerOwnsRegistration,
            thisContainerOwnsInstance,
            typeIsSingleton,
            childHasOverriddenRegistration,
            parentRegistrationIsSingletonPerContainer;
        if (this._isChildContainer) {
            thisContainerOwnsRegistration = this._registrations.hasOwnProperty(name);
            if (instance === undefined) {
                typeIsSingleton = registration.instanceLifecycleType === InstanceLifecycleType.singleton;
                // do we have the right to create it, or do we need to defer to the parent?
                if (!thisContainerOwnsRegistration && typeIsSingleton) {
                    // singletons always need to be resolved and stored with the container that owns the
                    // registration, otherwise the cached instance won't live in the right place
                    instance = this._parent.resolve(name);
                }
            } else {
                thisContainerOwnsInstance = this._instanceCache.hasOwnProperty(name);
                if (!thisContainerOwnsInstance) {
                    childHasOverriddenRegistration = thisContainerOwnsRegistration && !thisContainerOwnsInstance;
                    parentRegistrationIsSingletonPerContainer = !thisContainerOwnsRegistration && registration.instanceLifecycleType === InstanceLifecycleType.singletonPerContainer;
                    if (childHasOverriddenRegistration || parentRegistrationIsSingletonPerContainer) {
                        instance = undefined;
                    }
                }
            }
        }
        return instance;
    }
    _buildInstance(name) {
        var registration = this._registrations[name],
            dependencies = [],
            dependency,
            dependencyKey,
            i,
            context,
            instance,
            resolver;
        context = this._resolverContext.beginResolve(name);
        try {
            if (registration.dependencyList !== undefined) {
                for (i = 0; i < registration.dependencyList.length; i++) {
                    dependencyKey = registration.dependencyList[i];
                    if (utils.isString(dependencyKey)) {
                        dependency = this.resolve(dependencyKey);
                    } else if (dependencyKey.hasOwnProperty('type') && utils.isString(dependencyKey.type)) {
                        resolver = this._resolvers[dependencyKey.type];
                        if (resolver === undefined) {
                            throw new Error(utils.sprintf('Error resolving [%s]. No resolver plugin registered to resolve dependency key for type [%s]', name, dependencyKey.type));
                        }
                        dependency = resolver.resolve(this, dependencyKey);
                    } else {
                        throw new Error(utils.sprintf('Error resolving [%s]. It\'s dependency at index [%s] had an unknown resolver type', name, i));
                    }
                    dependencies.push(dependency);
                }
            }
            if (typeof registration.proto === 'function') {
                // haven't really tested this working with constructor functions too much
                // code ripped from here http://stackoverflow.com/questions/3362471/how-can-i-call-a-javascript-constructor-using-call-or-apply
                var Ctor = registration.proto.bind.apply(
                    registration.proto,
                    [null].concat(dependencies)
                );
                instance = new Ctor();
            } else {
                instance = Object.create(registration.proto);
                if (instance.init !== undefined) {
                    instance = instance.init.apply(instance, dependencies) || instance;
                }
            }

        } finally {
            context.endResolve();
        }
        return instance;
    }
    _validateDependencyList(dependencyList) {
    }
    _createDefaultResolvers() {
        return {
            // A resolvers that delegates to the dependency keys resolve method to perform the resolution.
            // It expects a dependency key in format:
            // { type: 'factory', resolve: function(container) { return someInstance } }
            factory: {
                resolve: (container, dependencyKey) => {
                    return dependencyKey.resolve(container);
                }
            },
            // A resolvers that returns a factory that when called will resolve the dependency from the container.
            // It expects a dependency key in format:
            // { type: 'autoFactory', name: "aDependencyName" }
            autoFactory: {
                resolve: (container, dependencyKey) => {
                    return () => {
                        return container.resolve(dependencyKey.name);
                    };
                }
            }
        };
    }
    _throwIsDisposed() {
        throw new Error("Container has been disposed");
    }
    _disposeContainer() {
        if (!this._isDisposed) {
            this._isDisposed = true;
            for (var prop in  this._instanceCache) {
                if (this._instanceCache.hasOwnProperty(prop)) {
                    var registration = this._registrations[prop];
                    if (registration.instanceLifecycleType !== InstanceLifecycleType.external) {
                        var instance = this._instanceCache[prop];
                        if (instance.dispose) {
                            instance.dispose();
                        }
                    }
                }
            }
            for (var i = 0, len = this._childContainers.length; i < len; i++) {
                var child = this._childContainers[i];
                child._disposeContainer();
            }
        }
    }
}