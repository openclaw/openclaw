'use strict';

var zod = require('zod');
var process$1 = require('process');
var chalk = require('chalk');
var lmsIsomorphic = require('@lmstudio/lms-isomorphic');
var zodToJsonSchema = require('zod-to-json-schema');

function isSignalLike(value) {
    return (typeof value === "object" &&
        value !== null &&
        typeof value.get === "function" &&
        typeof value.subscribe === "function");
}
/**
 * Base class for objects that can be subscribed to. Provides common utility methods.
 */
class Subscribable {
    subscribeWithCleaner(cleaner, listener) {
        const unsubscribe = this.subscribe(listener);
        cleaner.register(unsubscribe);
    }
    subscribeOnce(listener) {
        const unsubscribe = this.subscribe(data => {
            unsubscribe();
            listener(data);
        });
        return unsubscribe;
    }
    subscribeOnceWithCleaner(cleaner, listener) {
        const unsubscribe = this.subscribeOnce(listener);
        cleaner.register(unsubscribe);
    }
    derive(deriver, outputEqualsPredicate = (a, b) => a === b) {
        if (isSignalLike(this)) {
            return LazySignal.deriveFrom([this], deriver);
        }
        const thisWithGetter = this;
        if (thisWithGetter.get !== undefined) {
            const initialValue = thisWithGetter.get();
            if (initialValue === LazySignal.NOT_AVAILABLE) {
                return LazySignal.createWithoutInitialValue(setDownstream => {
                    return thisWithGetter.subscribe(data => {
                        if (isAvailable(data)) {
                            setDownstream(deriver(data));
                        }
                    });
                });
            }
            const thisNarrowed = thisWithGetter;
            return LazySignal.create(deriver(thisNarrowed.get()), setDownstream => {
                return thisNarrowed.subscribe(data => {
                    setDownstream(deriver(data));
                });
            }, outputEqualsPredicate);
        }
        return LazySignal.createWithoutInitialValue(setDownstream => {
            return this.subscribe(data => {
                if (isAvailable(data)) {
                    setDownstream(deriver(data));
                }
            });
        }, outputEqualsPredicate);
    }
}

/**
 * Represents an event that can be subscribed to. Emitted events will trigger all subscribers in the
 * next microtask. If multiple events are emitted, they will be triggered in the same microtask.
 */
class Event extends Subscribable {
    /**
     * Internal state that tracks whether the event has any subscribers.
     */
    constructor() {
        super();
        this.subscribers = new Set();
        /**
         * Internal callback that is called when the number of subscribers goes from 0 to 1.
         */
        this.onSubscribed = null;
        /**
         * Internal callback that is called when the number of subscribers goes from 1 to 0.
         */
        this.onUnsubscribed = null;
    }
    emit(data) {
        queueMicrotask(() => {
            for (const subscriber of this.subscribers) {
                subscriber(data);
            }
        });
    }
    static create() {
        const event = new Event();
        const emitter = data => {
            event.emit(data);
        };
        return [event, emitter];
    }
    subscribe(listener) {
        const previousSize = this.subscribers.size;
        this.subscribers.add(listener);
        if (previousSize === 0 && this.subscribers.size === 1) {
            this.onSubscribed?.();
        }
        return () => {
            const previousSize = this.subscribers.size;
            this.subscribers.delete(listener);
            if (previousSize === 1 && this.subscribers.size === 0) {
                this.onUnsubscribed?.();
            }
        };
    }
    batch({ minIdleTimeMs = 200, maxBatchTimeMs = 1000, }) {
        const [batchedEvent, emitBatchedEvent] = Event.create();
        batchedEvent.onSubscribed = () => {
            let batch = [];
            let emitBatchTimeout = null;
            let firstEventTime = 0;
            const emitBatch = () => {
                emitBatchTimeout = null;
                emitBatchedEvent(batch);
                batch = [];
            };
            batchedEvent.onUnsubscribed = this.subscribe(data => {
                batch.push(data);
                if (emitBatchTimeout === null) {
                    // No scheduled batch
                    firstEventTime = Date.now();
                    emitBatchTimeout = setTimeout(emitBatch, Math.min(minIdleTimeMs, maxBatchTimeMs));
                }
                else {
                    // Reschedule emission
                    clearTimeout(emitBatchTimeout);
                    const timeSinceFirstEvent = Date.now() - firstEventTime;
                    emitBatchTimeout = setTimeout(emitBatch, Math.min(minIdleTimeMs, Math.max(0, maxBatchTimeMs - timeSinceFirstEvent)));
                }
            });
        };
        return batchedEvent;
    }
}

function makePromise() {
    let resolve;
    let reject;
    const promise = new Promise((_resolve, _reject) => {
        resolve = _resolve;
        reject = _reject;
    });
    return { promise, resolve: resolve, reject: reject };
}

// src/utils/env.ts
var NOTHING = Symbol.for("immer-nothing");
var DRAFTABLE = Symbol.for("immer-draftable");
var DRAFT_STATE = Symbol.for("immer-state");

// src/utils/errors.ts
var errors = process.env.NODE_ENV !== "production" ? [
  // All error codes, starting by 0:
  function(plugin) {
    return `The plugin for '${plugin}' has not been loaded into Immer. To enable the plugin, import and call \`enable${plugin}()\` when initializing your application.`;
  },
  function(thing) {
    return `produce can only be called on things that are draftable: plain objects, arrays, Map, Set or classes that are marked with '[immerable]: true'. Got '${thing}'`;
  },
  "This object has been frozen and should not be mutated",
  function(data) {
    return "Cannot use a proxy that has been revoked. Did you pass an object from inside an immer function to an async process? " + data;
  },
  "An immer producer returned a new value *and* modified its draft. Either return a new value *or* modify the draft.",
  "Immer forbids circular references",
  "The first or second argument to `produce` must be a function",
  "The third argument to `produce` must be a function or undefined",
  "First argument to `createDraft` must be a plain object, an array, or an immerable object",
  "First argument to `finishDraft` must be a draft returned by `createDraft`",
  function(thing) {
    return `'current' expects a draft, got: ${thing}`;
  },
  "Object.defineProperty() cannot be used on an Immer draft",
  "Object.setPrototypeOf() cannot be used on an Immer draft",
  "Immer only supports deleting array indices",
  "Immer only supports setting array indices and the 'length' property",
  function(thing) {
    return `'original' expects a draft, got: ${thing}`;
  }
  // Note: if more errors are added, the errorOffset in Patches.ts should be increased
  // See Patches.ts for additional errors
] : [];
function die(error, ...args) {
  if (process.env.NODE_ENV !== "production") {
    const e = errors[error];
    const msg = typeof e === "function" ? e.apply(null, args) : e;
    throw new Error(`[Immer] ${msg}`);
  }
  throw new Error(
    `[Immer] minified error nr: ${error}. Full error at: https://bit.ly/3cXEKWf`
  );
}

// src/utils/common.ts
var getPrototypeOf = Object.getPrototypeOf;
function isDraft(value) {
  return !!value && !!value[DRAFT_STATE];
}
function isDraftable(value) {
  if (!value)
    return false;
  return isPlainObject$2(value) || Array.isArray(value) || !!value[DRAFTABLE] || !!value.constructor?.[DRAFTABLE] || isMap$1(value) || isSet$1(value);
}
var objectCtorString = Object.prototype.constructor.toString();
function isPlainObject$2(value) {
  if (!value || typeof value !== "object")
    return false;
  const proto = getPrototypeOf(value);
  if (proto === null) {
    return true;
  }
  const Ctor = Object.hasOwnProperty.call(proto, "constructor") && proto.constructor;
  if (Ctor === Object)
    return true;
  return typeof Ctor == "function" && Function.toString.call(Ctor) === objectCtorString;
}
function each(obj, iter) {
  if (getArchtype(obj) === 0 /* Object */) {
    Reflect.ownKeys(obj).forEach((key) => {
      iter(key, obj[key], obj);
    });
  } else {
    obj.forEach((entry, index) => iter(index, entry, obj));
  }
}
function getArchtype(thing) {
  const state = thing[DRAFT_STATE];
  return state ? state.type_ : Array.isArray(thing) ? 1 /* Array */ : isMap$1(thing) ? 2 /* Map */ : isSet$1(thing) ? 3 /* Set */ : 0 /* Object */;
}
function has(thing, prop) {
  return getArchtype(thing) === 2 /* Map */ ? thing.has(prop) : Object.prototype.hasOwnProperty.call(thing, prop);
}
function get(thing, prop) {
  return getArchtype(thing) === 2 /* Map */ ? thing.get(prop) : thing[prop];
}
function set(thing, propOrOldValue, value) {
  const t = getArchtype(thing);
  if (t === 2 /* Map */)
    thing.set(propOrOldValue, value);
  else if (t === 3 /* Set */) {
    thing.add(value);
  } else
    thing[propOrOldValue] = value;
}
function is(x, y) {
  if (x === y) {
    return x !== 0 || 1 / x === 1 / y;
  } else {
    return x !== x && y !== y;
  }
}
function isMap$1(target) {
  return target instanceof Map;
}
function isSet$1(target) {
  return target instanceof Set;
}
function latest(state) {
  return state.copy_ || state.base_;
}
function shallowCopy(base, strict) {
  if (isMap$1(base)) {
    return new Map(base);
  }
  if (isSet$1(base)) {
    return new Set(base);
  }
  if (Array.isArray(base))
    return Array.prototype.slice.call(base);
  const isPlain = isPlainObject$2(base);
  if (strict === true || strict === "class_only" && !isPlain) {
    const descriptors = Object.getOwnPropertyDescriptors(base);
    delete descriptors[DRAFT_STATE];
    let keys = Reflect.ownKeys(descriptors);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const desc = descriptors[key];
      if (desc.writable === false) {
        desc.writable = true;
        desc.configurable = true;
      }
      if (desc.get || desc.set)
        descriptors[key] = {
          configurable: true,
          writable: true,
          // could live with !!desc.set as well here...
          enumerable: desc.enumerable,
          value: base[key]
        };
    }
    return Object.create(getPrototypeOf(base), descriptors);
  } else {
    const proto = getPrototypeOf(base);
    if (proto !== null && isPlain) {
      return { ...base };
    }
    const obj = Object.create(proto);
    return Object.assign(obj, base);
  }
}
function freeze(obj, deep = false) {
  if (isFrozen(obj) || isDraft(obj) || !isDraftable(obj))
    return obj;
  if (getArchtype(obj) > 1) {
    obj.set = obj.add = obj.clear = obj.delete = dontMutateFrozenCollections;
  }
  Object.freeze(obj);
  if (deep)
    Object.values(obj).forEach((value) => freeze(value, true));
  return obj;
}
function dontMutateFrozenCollections() {
  die(2);
}
function isFrozen(obj) {
  return Object.isFrozen(obj);
}

// src/utils/plugins.ts
var plugins = {};
function getPlugin(pluginKey) {
  const plugin = plugins[pluginKey];
  if (!plugin) {
    die(0, pluginKey);
  }
  return plugin;
}
function loadPlugin(pluginKey, implementation) {
  if (!plugins[pluginKey])
    plugins[pluginKey] = implementation;
}

// src/core/scope.ts
var currentScope;
function getCurrentScope() {
  return currentScope;
}
function createScope(parent_, immer_) {
  return {
    drafts_: [],
    parent_,
    immer_,
    // Whenever the modified draft contains a draft from another scope, we
    // need to prevent auto-freezing so the unowned draft can be finalized.
    canAutoFreeze_: true,
    unfinalizedDrafts_: 0
  };
}
function usePatchesInScope(scope, patchListener) {
  if (patchListener) {
    getPlugin("Patches");
    scope.patches_ = [];
    scope.inversePatches_ = [];
    scope.patchListener_ = patchListener;
  }
}
function revokeScope(scope) {
  leaveScope(scope);
  scope.drafts_.forEach(revokeDraft);
  scope.drafts_ = null;
}
function leaveScope(scope) {
  if (scope === currentScope) {
    currentScope = scope.parent_;
  }
}
function enterScope(immer2) {
  return currentScope = createScope(currentScope, immer2);
}
function revokeDraft(draft) {
  const state = draft[DRAFT_STATE];
  if (state.type_ === 0 /* Object */ || state.type_ === 1 /* Array */)
    state.revoke_();
  else
    state.revoked_ = true;
}

// src/core/finalize.ts
function processResult(result, scope) {
  scope.unfinalizedDrafts_ = scope.drafts_.length;
  const baseDraft = scope.drafts_[0];
  const isReplaced = result !== void 0 && result !== baseDraft;
  if (isReplaced) {
    if (baseDraft[DRAFT_STATE].modified_) {
      revokeScope(scope);
      die(4);
    }
    if (isDraftable(result)) {
      result = finalize(scope, result);
      if (!scope.parent_)
        maybeFreeze(scope, result);
    }
    if (scope.patches_) {
      getPlugin("Patches").generateReplacementPatches_(
        baseDraft[DRAFT_STATE].base_,
        result,
        scope.patches_,
        scope.inversePatches_
      );
    }
  } else {
    result = finalize(scope, baseDraft, []);
  }
  revokeScope(scope);
  if (scope.patches_) {
    scope.patchListener_(scope.patches_, scope.inversePatches_);
  }
  return result !== NOTHING ? result : void 0;
}
function finalize(rootScope, value, path) {
  if (isFrozen(value))
    return value;
  const state = value[DRAFT_STATE];
  if (!state) {
    each(
      value,
      (key, childValue) => finalizeProperty(rootScope, state, value, key, childValue, path)
    );
    return value;
  }
  if (state.scope_ !== rootScope)
    return value;
  if (!state.modified_) {
    maybeFreeze(rootScope, state.base_, true);
    return state.base_;
  }
  if (!state.finalized_) {
    state.finalized_ = true;
    state.scope_.unfinalizedDrafts_--;
    const result = state.copy_;
    let resultEach = result;
    let isSet2 = false;
    if (state.type_ === 3 /* Set */) {
      resultEach = new Set(result);
      result.clear();
      isSet2 = true;
    }
    each(
      resultEach,
      (key, childValue) => finalizeProperty(rootScope, state, result, key, childValue, path, isSet2)
    );
    maybeFreeze(rootScope, result, false);
    if (path && rootScope.patches_) {
      getPlugin("Patches").generatePatches_(
        state,
        path,
        rootScope.patches_,
        rootScope.inversePatches_
      );
    }
  }
  return state.copy_;
}
function finalizeProperty(rootScope, parentState, targetObject, prop, childValue, rootPath, targetIsSet) {
  if (process.env.NODE_ENV !== "production" && childValue === targetObject)
    die(5);
  if (isDraft(childValue)) {
    const path = rootPath && parentState && parentState.type_ !== 3 /* Set */ && // Set objects are atomic since they have no keys.
    !has(parentState.assigned_, prop) ? rootPath.concat(prop) : void 0;
    const res = finalize(rootScope, childValue, path);
    set(targetObject, prop, res);
    if (isDraft(res)) {
      rootScope.canAutoFreeze_ = false;
    } else
      return;
  } else if (targetIsSet) {
    targetObject.add(childValue);
  }
  if (isDraftable(childValue) && !isFrozen(childValue)) {
    if (!rootScope.immer_.autoFreeze_ && rootScope.unfinalizedDrafts_ < 1) {
      return;
    }
    finalize(rootScope, childValue);
    if ((!parentState || !parentState.scope_.parent_) && typeof prop !== "symbol" && Object.prototype.propertyIsEnumerable.call(targetObject, prop))
      maybeFreeze(rootScope, childValue);
  }
}
function maybeFreeze(scope, value, deep = false) {
  if (!scope.parent_ && scope.immer_.autoFreeze_ && scope.canAutoFreeze_) {
    freeze(value, deep);
  }
}

// src/core/proxy.ts
function createProxyProxy(base, parent) {
  const isArray = Array.isArray(base);
  const state = {
    type_: isArray ? 1 /* Array */ : 0 /* Object */,
    // Track which produce call this is associated with.
    scope_: parent ? parent.scope_ : getCurrentScope(),
    // True for both shallow and deep changes.
    modified_: false,
    // Used during finalization.
    finalized_: false,
    // Track which properties have been assigned (true) or deleted (false).
    assigned_: {},
    // The parent draft state.
    parent_: parent,
    // The base state.
    base_: base,
    // The base proxy.
    draft_: null,
    // set below
    // The base copy with any updated values.
    copy_: null,
    // Called by the `produce` function.
    revoke_: null,
    isManual_: false
  };
  let target = state;
  let traps = objectTraps;
  if (isArray) {
    target = [state];
    traps = arrayTraps;
  }
  const { revoke, proxy } = Proxy.revocable(target, traps);
  state.draft_ = proxy;
  state.revoke_ = revoke;
  return proxy;
}
var objectTraps = {
  get(state, prop) {
    if (prop === DRAFT_STATE)
      return state;
    const source = latest(state);
    if (!has(source, prop)) {
      return readPropFromProto(state, source, prop);
    }
    const value = source[prop];
    if (state.finalized_ || !isDraftable(value)) {
      return value;
    }
    if (value === peek(state.base_, prop)) {
      prepareCopy(state);
      return state.copy_[prop] = createProxy(value, state);
    }
    return value;
  },
  has(state, prop) {
    return prop in latest(state);
  },
  ownKeys(state) {
    return Reflect.ownKeys(latest(state));
  },
  set(state, prop, value) {
    const desc = getDescriptorFromProto(latest(state), prop);
    if (desc?.set) {
      desc.set.call(state.draft_, value);
      return true;
    }
    if (!state.modified_) {
      const current2 = peek(latest(state), prop);
      const currentState = current2?.[DRAFT_STATE];
      if (currentState && currentState.base_ === value) {
        state.copy_[prop] = value;
        state.assigned_[prop] = false;
        return true;
      }
      if (is(value, current2) && (value !== void 0 || has(state.base_, prop)))
        return true;
      prepareCopy(state);
      markChanged(state);
    }
    if (state.copy_[prop] === value && // special case: handle new props with value 'undefined'
    (value !== void 0 || prop in state.copy_) || // special case: NaN
    Number.isNaN(value) && Number.isNaN(state.copy_[prop]))
      return true;
    state.copy_[prop] = value;
    state.assigned_[prop] = true;
    return true;
  },
  deleteProperty(state, prop) {
    if (peek(state.base_, prop) !== void 0 || prop in state.base_) {
      state.assigned_[prop] = false;
      prepareCopy(state);
      markChanged(state);
    } else {
      delete state.assigned_[prop];
    }
    if (state.copy_) {
      delete state.copy_[prop];
    }
    return true;
  },
  // Note: We never coerce `desc.value` into an Immer draft, because we can't make
  // the same guarantee in ES5 mode.
  getOwnPropertyDescriptor(state, prop) {
    const owner = latest(state);
    const desc = Reflect.getOwnPropertyDescriptor(owner, prop);
    if (!desc)
      return desc;
    return {
      writable: true,
      configurable: state.type_ !== 1 /* Array */ || prop !== "length",
      enumerable: desc.enumerable,
      value: owner[prop]
    };
  },
  defineProperty() {
    die(11);
  },
  getPrototypeOf(state) {
    return getPrototypeOf(state.base_);
  },
  setPrototypeOf() {
    die(12);
  }
};
var arrayTraps = {};
each(objectTraps, (key, fn) => {
  arrayTraps[key] = function() {
    arguments[0] = arguments[0][0];
    return fn.apply(this, arguments);
  };
});
arrayTraps.deleteProperty = function(state, prop) {
  if (process.env.NODE_ENV !== "production" && isNaN(parseInt(prop)))
    die(13);
  return arrayTraps.set.call(this, state, prop, void 0);
};
arrayTraps.set = function(state, prop, value) {
  if (process.env.NODE_ENV !== "production" && prop !== "length" && isNaN(parseInt(prop)))
    die(14);
  return objectTraps.set.call(this, state[0], prop, value, state[0]);
};
function peek(draft, prop) {
  const state = draft[DRAFT_STATE];
  const source = state ? latest(state) : draft;
  return source[prop];
}
function readPropFromProto(state, source, prop) {
  const desc = getDescriptorFromProto(source, prop);
  return desc ? `value` in desc ? desc.value : (
    // This is a very special case, if the prop is a getter defined by the
    // prototype, we should invoke it with the draft as context!
    desc.get?.call(state.draft_)
  ) : void 0;
}
function getDescriptorFromProto(source, prop) {
  if (!(prop in source))
    return void 0;
  let proto = getPrototypeOf(source);
  while (proto) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (desc)
      return desc;
    proto = getPrototypeOf(proto);
  }
  return void 0;
}
function markChanged(state) {
  if (!state.modified_) {
    state.modified_ = true;
    if (state.parent_) {
      markChanged(state.parent_);
    }
  }
}
function prepareCopy(state) {
  if (!state.copy_) {
    state.copy_ = shallowCopy(
      state.base_,
      state.scope_.immer_.useStrictShallowCopy_
    );
  }
}

// src/core/immerClass.ts
var Immer2 = class {
  constructor(config) {
    this.autoFreeze_ = true;
    this.useStrictShallowCopy_ = false;
    /**
     * The `produce` function takes a value and a "recipe function" (whose
     * return value often depends on the base state). The recipe function is
     * free to mutate its first argument however it wants. All mutations are
     * only ever applied to a __copy__ of the base state.
     *
     * Pass only a function to create a "curried producer" which relieves you
     * from passing the recipe function every time.
     *
     * Only plain objects and arrays are made mutable. All other objects are
     * considered uncopyable.
     *
     * Note: This function is __bound__ to its `Immer` instance.
     *
     * @param {any} base - the initial state
     * @param {Function} recipe - function that receives a proxy of the base state as first argument and which can be freely modified
     * @param {Function} patchListener - optional function that will be called with all the patches produced here
     * @returns {any} a new state, or the initial state if nothing was modified
     */
    this.produce = (base, recipe, patchListener) => {
      if (typeof base === "function" && typeof recipe !== "function") {
        const defaultBase = recipe;
        recipe = base;
        const self = this;
        return function curriedProduce(base2 = defaultBase, ...args) {
          return self.produce(base2, (draft) => recipe.call(this, draft, ...args));
        };
      }
      if (typeof recipe !== "function")
        die(6);
      if (patchListener !== void 0 && typeof patchListener !== "function")
        die(7);
      let result;
      if (isDraftable(base)) {
        const scope = enterScope(this);
        const proxy = createProxy(base, void 0);
        let hasError = true;
        try {
          result = recipe(proxy);
          hasError = false;
        } finally {
          if (hasError)
            revokeScope(scope);
          else
            leaveScope(scope);
        }
        usePatchesInScope(scope, patchListener);
        return processResult(result, scope);
      } else if (!base || typeof base !== "object") {
        result = recipe(base);
        if (result === void 0)
          result = base;
        if (result === NOTHING)
          result = void 0;
        if (this.autoFreeze_)
          freeze(result, true);
        if (patchListener) {
          const p = [];
          const ip = [];
          getPlugin("Patches").generateReplacementPatches_(base, result, p, ip);
          patchListener(p, ip);
        }
        return result;
      } else
        die(1, base);
    };
    this.produceWithPatches = (base, recipe) => {
      if (typeof base === "function") {
        return (state, ...args) => this.produceWithPatches(state, (draft) => base(draft, ...args));
      }
      let patches, inversePatches;
      const result = this.produce(base, recipe, (p, ip) => {
        patches = p;
        inversePatches = ip;
      });
      return [result, patches, inversePatches];
    };
    if (typeof config?.autoFreeze === "boolean")
      this.setAutoFreeze(config.autoFreeze);
    if (typeof config?.useStrictShallowCopy === "boolean")
      this.setUseStrictShallowCopy(config.useStrictShallowCopy);
  }
  createDraft(base) {
    if (!isDraftable(base))
      die(8);
    if (isDraft(base))
      base = current(base);
    const scope = enterScope(this);
    const proxy = createProxy(base, void 0);
    proxy[DRAFT_STATE].isManual_ = true;
    leaveScope(scope);
    return proxy;
  }
  finishDraft(draft, patchListener) {
    const state = draft && draft[DRAFT_STATE];
    if (!state || !state.isManual_)
      die(9);
    const { scope_: scope } = state;
    usePatchesInScope(scope, patchListener);
    return processResult(void 0, scope);
  }
  /**
   * Pass true to automatically freeze all copies created by Immer.
   *
   * By default, auto-freezing is enabled.
   */
  setAutoFreeze(value) {
    this.autoFreeze_ = value;
  }
  /**
   * Pass true to enable strict shallow copy.
   *
   * By default, immer does not copy the object descriptors such as getter, setter and non-enumrable properties.
   */
  setUseStrictShallowCopy(value) {
    this.useStrictShallowCopy_ = value;
  }
  applyPatches(base, patches) {
    let i;
    for (i = patches.length - 1; i >= 0; i--) {
      const patch = patches[i];
      if (patch.path.length === 0 && patch.op === "replace") {
        base = patch.value;
        break;
      }
    }
    if (i > -1) {
      patches = patches.slice(i + 1);
    }
    const applyPatchesImpl = getPlugin("Patches").applyPatches_;
    if (isDraft(base)) {
      return applyPatchesImpl(base, patches);
    }
    return this.produce(
      base,
      (draft) => applyPatchesImpl(draft, patches)
    );
  }
};
function createProxy(value, parent) {
  const draft = isMap$1(value) ? getPlugin("MapSet").proxyMap_(value, parent) : isSet$1(value) ? getPlugin("MapSet").proxySet_(value, parent) : createProxyProxy(value, parent);
  const scope = parent ? parent.scope_ : getCurrentScope();
  scope.drafts_.push(draft);
  return draft;
}

// src/core/current.ts
function current(value) {
  if (!isDraft(value))
    die(10, value);
  return currentImpl(value);
}
function currentImpl(value) {
  if (!isDraftable(value) || isFrozen(value))
    return value;
  const state = value[DRAFT_STATE];
  let copy;
  if (state) {
    if (!state.modified_)
      return state.base_;
    state.finalized_ = true;
    copy = shallowCopy(value, state.scope_.immer_.useStrictShallowCopy_);
  } else {
    copy = shallowCopy(value, true);
  }
  each(copy, (key, childValue) => {
    set(copy, key, currentImpl(childValue));
  });
  if (state) {
    state.finalized_ = false;
  }
  return copy;
}

// src/plugins/mapset.ts
function enableMapSet() {
  class DraftMap extends Map {
    constructor(target, parent) {
      super();
      this[DRAFT_STATE] = {
        type_: 2 /* Map */,
        parent_: parent,
        scope_: parent ? parent.scope_ : getCurrentScope(),
        modified_: false,
        finalized_: false,
        copy_: void 0,
        assigned_: void 0,
        base_: target,
        draft_: this,
        isManual_: false,
        revoked_: false
      };
    }
    get size() {
      return latest(this[DRAFT_STATE]).size;
    }
    has(key) {
      return latest(this[DRAFT_STATE]).has(key);
    }
    set(key, value) {
      const state = this[DRAFT_STATE];
      assertUnrevoked(state);
      if (!latest(state).has(key) || latest(state).get(key) !== value) {
        prepareMapCopy(state);
        markChanged(state);
        state.assigned_.set(key, true);
        state.copy_.set(key, value);
        state.assigned_.set(key, true);
      }
      return this;
    }
    delete(key) {
      if (!this.has(key)) {
        return false;
      }
      const state = this[DRAFT_STATE];
      assertUnrevoked(state);
      prepareMapCopy(state);
      markChanged(state);
      if (state.base_.has(key)) {
        state.assigned_.set(key, false);
      } else {
        state.assigned_.delete(key);
      }
      state.copy_.delete(key);
      return true;
    }
    clear() {
      const state = this[DRAFT_STATE];
      assertUnrevoked(state);
      if (latest(state).size) {
        prepareMapCopy(state);
        markChanged(state);
        state.assigned_ = /* @__PURE__ */ new Map();
        each(state.base_, (key) => {
          state.assigned_.set(key, false);
        });
        state.copy_.clear();
      }
    }
    forEach(cb, thisArg) {
      const state = this[DRAFT_STATE];
      latest(state).forEach((_value, key, _map) => {
        cb.call(thisArg, this.get(key), key, this);
      });
    }
    get(key) {
      const state = this[DRAFT_STATE];
      assertUnrevoked(state);
      const value = latest(state).get(key);
      if (state.finalized_ || !isDraftable(value)) {
        return value;
      }
      if (value !== state.base_.get(key)) {
        return value;
      }
      const draft = createProxy(value, state);
      prepareMapCopy(state);
      state.copy_.set(key, draft);
      return draft;
    }
    keys() {
      return latest(this[DRAFT_STATE]).keys();
    }
    values() {
      const iterator = this.keys();
      return {
        [Symbol.iterator]: () => this.values(),
        next: () => {
          const r = iterator.next();
          if (r.done)
            return r;
          const value = this.get(r.value);
          return {
            done: false,
            value
          };
        }
      };
    }
    entries() {
      const iterator = this.keys();
      return {
        [Symbol.iterator]: () => this.entries(),
        next: () => {
          const r = iterator.next();
          if (r.done)
            return r;
          const value = this.get(r.value);
          return {
            done: false,
            value: [r.value, value]
          };
        }
      };
    }
    [(Symbol.iterator)]() {
      return this.entries();
    }
  }
  function proxyMap_(target, parent) {
    return new DraftMap(target, parent);
  }
  function prepareMapCopy(state) {
    if (!state.copy_) {
      state.assigned_ = /* @__PURE__ */ new Map();
      state.copy_ = new Map(state.base_);
    }
  }
  class DraftSet extends Set {
    constructor(target, parent) {
      super();
      this[DRAFT_STATE] = {
        type_: 3 /* Set */,
        parent_: parent,
        scope_: parent ? parent.scope_ : getCurrentScope(),
        modified_: false,
        finalized_: false,
        copy_: void 0,
        base_: target,
        draft_: this,
        drafts_: /* @__PURE__ */ new Map(),
        revoked_: false,
        isManual_: false
      };
    }
    get size() {
      return latest(this[DRAFT_STATE]).size;
    }
    has(value) {
      const state = this[DRAFT_STATE];
      assertUnrevoked(state);
      if (!state.copy_) {
        return state.base_.has(value);
      }
      if (state.copy_.has(value))
        return true;
      if (state.drafts_.has(value) && state.copy_.has(state.drafts_.get(value)))
        return true;
      return false;
    }
    add(value) {
      const state = this[DRAFT_STATE];
      assertUnrevoked(state);
      if (!this.has(value)) {
        prepareSetCopy(state);
        markChanged(state);
        state.copy_.add(value);
      }
      return this;
    }
    delete(value) {
      if (!this.has(value)) {
        return false;
      }
      const state = this[DRAFT_STATE];
      assertUnrevoked(state);
      prepareSetCopy(state);
      markChanged(state);
      return state.copy_.delete(value) || (state.drafts_.has(value) ? state.copy_.delete(state.drafts_.get(value)) : (
        /* istanbul ignore next */
        false
      ));
    }
    clear() {
      const state = this[DRAFT_STATE];
      assertUnrevoked(state);
      if (latest(state).size) {
        prepareSetCopy(state);
        markChanged(state);
        state.copy_.clear();
      }
    }
    values() {
      const state = this[DRAFT_STATE];
      assertUnrevoked(state);
      prepareSetCopy(state);
      return state.copy_.values();
    }
    entries() {
      const state = this[DRAFT_STATE];
      assertUnrevoked(state);
      prepareSetCopy(state);
      return state.copy_.entries();
    }
    keys() {
      return this.values();
    }
    [(Symbol.iterator)]() {
      return this.values();
    }
    forEach(cb, thisArg) {
      const iterator = this.values();
      let result = iterator.next();
      while (!result.done) {
        cb.call(thisArg, result.value, result.value, this);
        result = iterator.next();
      }
    }
  }
  function proxySet_(target, parent) {
    return new DraftSet(target, parent);
  }
  function prepareSetCopy(state) {
    if (!state.copy_) {
      state.copy_ = /* @__PURE__ */ new Set();
      state.base_.forEach((value) => {
        if (isDraftable(value)) {
          const draft = createProxy(value, state);
          state.drafts_.set(value, draft);
          state.copy_.add(draft);
        } else {
          state.copy_.add(value);
        }
      });
    }
  }
  function assertUnrevoked(state) {
    if (state.revoked_)
      die(3, JSON.stringify(latest(state)));
  }
  loadPlugin("MapSet", { proxyMap_, proxySet_ });
}

// src/plugins/patches.ts
function enablePatches() {
  const errorOffset = 16;
  if (process.env.NODE_ENV !== "production") {
    errors.push(
      'Sets cannot have "replace" patches.',
      function(op) {
        return "Unsupported patch operation: " + op;
      },
      function(path) {
        return "Cannot apply patch, path doesn't resolve: " + path;
      },
      "Patching reserved attributes like __proto__, prototype and constructor is not allowed"
    );
  }
  const REPLACE = "replace";
  const ADD = "add";
  const REMOVE = "remove";
  function generatePatches_(state, basePath, patches, inversePatches) {
    switch (state.type_) {
      case 0 /* Object */:
      case 2 /* Map */:
        return generatePatchesFromAssigned(
          state,
          basePath,
          patches,
          inversePatches
        );
      case 1 /* Array */:
        return generateArrayPatches(state, basePath, patches, inversePatches);
      case 3 /* Set */:
        return generateSetPatches(
          state,
          basePath,
          patches,
          inversePatches
        );
    }
  }
  function generateArrayPatches(state, basePath, patches, inversePatches) {
    let { base_, assigned_ } = state;
    let copy_ = state.copy_;
    if (copy_.length < base_.length) {
      [base_, copy_] = [copy_, base_];
      [patches, inversePatches] = [inversePatches, patches];
    }
    for (let i = 0; i < base_.length; i++) {
      if (assigned_[i] && copy_[i] !== base_[i]) {
        const path = basePath.concat([i]);
        patches.push({
          op: REPLACE,
          path,
          // Need to maybe clone it, as it can in fact be the original value
          // due to the base/copy inversion at the start of this function
          value: clonePatchValueIfNeeded(copy_[i])
        });
        inversePatches.push({
          op: REPLACE,
          path,
          value: clonePatchValueIfNeeded(base_[i])
        });
      }
    }
    for (let i = base_.length; i < copy_.length; i++) {
      const path = basePath.concat([i]);
      patches.push({
        op: ADD,
        path,
        // Need to maybe clone it, as it can in fact be the original value
        // due to the base/copy inversion at the start of this function
        value: clonePatchValueIfNeeded(copy_[i])
      });
    }
    for (let i = copy_.length - 1; base_.length <= i; --i) {
      const path = basePath.concat([i]);
      inversePatches.push({
        op: REMOVE,
        path
      });
    }
  }
  function generatePatchesFromAssigned(state, basePath, patches, inversePatches) {
    const { base_, copy_ } = state;
    each(state.assigned_, (key, assignedValue) => {
      const origValue = get(base_, key);
      const value = get(copy_, key);
      const op = !assignedValue ? REMOVE : has(base_, key) ? REPLACE : ADD;
      if (origValue === value && op === REPLACE)
        return;
      const path = basePath.concat(key);
      patches.push(op === REMOVE ? { op, path } : { op, path, value });
      inversePatches.push(
        op === ADD ? { op: REMOVE, path } : op === REMOVE ? { op: ADD, path, value: clonePatchValueIfNeeded(origValue) } : { op: REPLACE, path, value: clonePatchValueIfNeeded(origValue) }
      );
    });
  }
  function generateSetPatches(state, basePath, patches, inversePatches) {
    let { base_, copy_ } = state;
    let i = 0;
    base_.forEach((value) => {
      if (!copy_.has(value)) {
        const path = basePath.concat([i]);
        patches.push({
          op: REMOVE,
          path,
          value
        });
        inversePatches.unshift({
          op: ADD,
          path,
          value
        });
      }
      i++;
    });
    i = 0;
    copy_.forEach((value) => {
      if (!base_.has(value)) {
        const path = basePath.concat([i]);
        patches.push({
          op: ADD,
          path,
          value
        });
        inversePatches.unshift({
          op: REMOVE,
          path,
          value
        });
      }
      i++;
    });
  }
  function generateReplacementPatches_(baseValue, replacement, patches, inversePatches) {
    patches.push({
      op: REPLACE,
      path: [],
      value: replacement === NOTHING ? void 0 : replacement
    });
    inversePatches.push({
      op: REPLACE,
      path: [],
      value: baseValue
    });
  }
  function applyPatches_(draft, patches) {
    patches.forEach((patch) => {
      const { path, op } = patch;
      let base = draft;
      for (let i = 0; i < path.length - 1; i++) {
        const parentType = getArchtype(base);
        let p = path[i];
        if (typeof p !== "string" && typeof p !== "number") {
          p = "" + p;
        }
        if ((parentType === 0 /* Object */ || parentType === 1 /* Array */) && (p === "__proto__" || p === "constructor"))
          die(errorOffset + 3);
        if (typeof base === "function" && p === "prototype")
          die(errorOffset + 3);
        base = get(base, p);
        if (typeof base !== "object")
          die(errorOffset + 2, path.join("/"));
      }
      const type = getArchtype(base);
      const value = deepClonePatchValue(patch.value);
      const key = path[path.length - 1];
      switch (op) {
        case REPLACE:
          switch (type) {
            case 2 /* Map */:
              return base.set(key, value);
            case 3 /* Set */:
              die(errorOffset);
            default:
              return base[key] = value;
          }
        case ADD:
          switch (type) {
            case 1 /* Array */:
              return key === "-" ? base.push(value) : base.splice(key, 0, value);
            case 2 /* Map */:
              return base.set(key, value);
            case 3 /* Set */:
              return base.add(value);
            default:
              return base[key] = value;
          }
        case REMOVE:
          switch (type) {
            case 1 /* Array */:
              return base.splice(key, 1);
            case 2 /* Map */:
              return base.delete(key);
            case 3 /* Set */:
              return base.delete(patch.value);
            default:
              return delete base[key];
          }
        default:
          die(errorOffset + 1, op);
      }
    });
    return draft;
  }
  function deepClonePatchValue(obj) {
    if (!isDraftable(obj))
      return obj;
    if (Array.isArray(obj))
      return obj.map(deepClonePatchValue);
    if (isMap$1(obj))
      return new Map(
        Array.from(obj.entries()).map(([k, v]) => [k, deepClonePatchValue(v)])
      );
    if (isSet$1(obj))
      return new Set(Array.from(obj).map(deepClonePatchValue));
    const cloned = Object.create(getPrototypeOf(obj));
    for (const key in obj)
      cloned[key] = deepClonePatchValue(obj[key]);
    if (has(obj, DRAFTABLE))
      cloned[DRAFTABLE] = obj[DRAFTABLE];
    return cloned;
  }
  function clonePatchValueIfNeeded(obj) {
    if (isDraft(obj)) {
      return deepClonePatchValue(obj);
    } else
      return obj;
  }
  loadPlugin("Patches", {
    applyPatches_,
    generatePatches_,
    generateReplacementPatches_
  });
}

// src/immer.ts
var immer = new Immer2();
immer.produce;
var produceWithPatches = immer.produceWithPatches.bind(
  immer
);
immer.setAutoFreeze.bind(immer);
immer.setUseStrictShallowCopy.bind(immer);
var applyPatches = immer.applyPatches.bind(immer);
immer.createDraft.bind(immer);
immer.finishDraft.bind(immer);
enableMapSet();
enablePatches();

/**
 * Concatenate Writable Tags
 */
function cwt(...allTags) {
    return allTags
        .filter(tags => tags !== undefined)
        .reduce((acc, tags) => acc.concat(tags), []);
}
function makeRootReplacingPatches(value) {
    return [
        {
            op: "replace",
            path: [],
            value,
        },
    ];
}
/**
 * Creates a setter function that can be used to update a value. This setter will also return the
 * patches that were applied to the value.
 */
function makeSetterWithPatches(update, prependTagsFn) {
    const setter = (value, tags) => {
        update(() => [value, makeRootReplacingPatches(value)], cwt(prependTagsFn?.(), tags));
    };
    setter.withProducer = (producer, tags) => {
        update(oldData => {
            const [newData, patches] = produceWithPatches(oldData, producer);
            if (isAvailable(newData)) {
                return [newData, patches];
            }
            throw new Error("Cannot update value to NOT_AVAILABLE");
        }, cwt(prependTagsFn?.(), tags));
    };
    setter.withUpdater = (updater, tags) => {
        update(oldData => {
            const newData = updater(oldData);
            return [newData, makeRootReplacingPatches(newData)];
        }, cwt(prependTagsFn?.(), tags));
    };
    setter.withPatchUpdater = (updater, tags) => {
        update(updater, cwt(prependTagsFn?.(), tags));
    };
    setter.withPatches = (patches, tags) => {
        update(oldData => {
            return [applyPatches(oldData, patches), patches];
        }, cwt(prependTagsFn?.(), tags));
    };
    setter.withValueAndPatches = (newValue, patches, tags) => {
        update(() => [newValue, patches], cwt(prependTagsFn?.(), tags));
    };
    return setter;
}

const equals = (a, b) => a === b;
/**
 * A signal is a wrapper for a value. It can be used to notify subscribers when the value changes.
 * For it to work properly, the value should be immutable.
 *
 * To create a signal, please use the `Signal.create` static method. It will return a signal
 * along with a function to update its value.
 */
class Signal extends Subscribable {
    /**
     * Creates a signal.
     *
     * @param value - The initial value of the signal.
     * @param equalsPredicate - A function to compare two values. The subscribers will only be called
     * if the value changes according to the `equalsPredicate`. By default, it uses the `===`
     * operator.
     * @returns This method returns a tuple with two elements:
     * - The signal
     * - A function to update the value
     **/
    static create(value, equalsPredicate = equals) {
        const signal = new Signal(value, equalsPredicate);
        const update = (updater, tags) => {
            signal.update(updater, tags);
        };
        const setter = makeSetterWithPatches(update);
        return [signal, setter];
    }
    static createReadonly(value) {
        return Signal.create(value)[0];
    }
    constructor(value, equalsPredicate) {
        super();
        this.value = value;
        this.equalsPredicate = equalsPredicate;
        this.subscribers = new Set();
        this.queuedUpdaters = [];
        this.isEmitting = false;
    }
    /**
     * Returns the current value of the signal.
     */
    get() {
        return this.value;
    }
    pull() {
        return this.value;
    }
    notifyFull(value, patches, tags) {
        for (const { type, callback } of this.subscribers) {
            if (type === "full") {
                callback(value, patches, tags);
            }
        }
    }
    notifyAll(value, patches, tags) {
        for (const { type, callback } of this.subscribers) {
            if (type === "regular") {
                callback(value);
            }
            else {
                callback(value, patches, tags);
            }
        }
    }
    notifyAndUpdateIfChanged(value, patches, tags) {
        // If the value has changed, or if there are any tags that need to be flushed, notify
        if (!this.equalsPredicate(this.value, value)) {
            this.value = value;
            // If the values have changed, notify everyone
            this.notifyAll(value, patches, tags);
        }
        else if (tags.length > 0) {
            // If values not changed, but there is a tag to be flushed, notify only full subscribers
            this.notifyFull(value, patches, tags);
        }
    }
    isReplaceRoot(patch) {
        return patch.path.length === 0 && patch.op === "replace";
    }
    update(updater, tags) {
        this.queuedUpdaters.push([updater, tags]);
        // Only one concurrent update may emit
        if (this.isEmitting) {
            return;
        }
        this.isEmitting = true;
        try {
            // Outer while is for handling new updates caused by the notify
            while (this.queuedUpdaters.length > 0) {
                let value = this.value;
                let patches = [];
                const tags = [];
                // Inner while is for handling multiple updates
                while (this.queuedUpdaters.length > 0) {
                    const [updater, newTags] = this.queuedUpdaters.shift();
                    const [newValue, newPatches] = updater(value);
                    value = newValue;
                    // Extremely rudimentary patch merging
                    const rootReplacerIndex = newPatches.findIndex(this.isReplaceRoot);
                    if (rootReplacerIndex !== -1) {
                        patches = newPatches.slice(rootReplacerIndex);
                    }
                    else {
                        patches.push(...newPatches);
                    }
                    if (newTags !== undefined) {
                        tags.push(...newTags);
                    }
                }
                this.notifyAndUpdateIfChanged(value, patches, tags);
            }
        }
        finally {
            this.isEmitting = false;
        }
    }
    /**
     * Subscribes to the signal. The callback will be called whenever the value changes. All callbacks
     * are called synchronously upon updating. It will NOT be immediately called with the current
     * value. (Use `get()` to get the current value.) Returns a function to unsubscribe.
     *
     * Edge cases involving manipulating the signal in the callback:
     *
     * - If the callback adds new subscribers, they will also be called within the same update.
     * - If the callback causes removal of subscribers that have not been called yet, they will no
     *   longer be called.
     * - If the callback causes an update of the value, the update will be queued. If multiple updates
     *   are queued, only the last one will be executed.
     *
     * Edge cases involving adding the same callback multiple times.
     *
     *  - Callbacks are tracked with a set. Adding the same subscriber will not cause it to be called
     *    multiple times.
     */
    subscribe(callback) {
        const subscriber = {
            type: "regular",
            callback,
        };
        this.subscribers.add(subscriber);
        return () => {
            this.subscribers.delete(subscriber);
        };
    }
    /**
     * Subscribes to the signal with the callback and trigger the callback immediately with the
     * current value.
     */
    subscribeAndNow(callback) {
        const unsubscribe = this.subscribe(callback);
        callback(this.value);
        return unsubscribe;
    }
    subscribeFull(callback) {
        const subscriber = {
            type: "full",
            callback,
        };
        this.subscribers.add(subscriber);
        return () => {
            this.subscribers.delete(subscriber);
        };
    }
    /**
     * Wait until the signal satisfies a predicate. If the predicate is already satisfied, it will
     * return immediately. Otherwise, it will wait until the signal satisfies the predicate.
     */
    async until(predicate) {
        const current = this.get();
        if (predicate(current)) {
            return current;
        }
        const { promise, resolve } = makePromise();
        const unsubscribe = this.subscribe(data => {
            if (predicate(data)) {
                resolve(data);
                unsubscribe();
            }
        });
        return await promise;
    }
}

function isAvailable(data) {
    return data !== LazySignal.NOT_AVAILABLE;
}
/**
 * A lazy signal is a signal that will only subscribe to the upstream when at least one subscriber
 * is attached. It will unsubscribe from the upstream when the last subscriber is removed.
 *
 * A lazy signal can possess a special value "NOT_AVAILABLE", accessible from the static property
 * {@link LazySignal.NOT_AVAILABLE}. This value is used to indicate that the value is not available
 * yet. This can happen when the signal is created without an initial value and the upstream has not
 * emitted a value yet.
 */
class LazySignal extends Subscribable {
    static { this.NOT_AVAILABLE = Symbol("notAvailable"); }
    static create(initialValue, subscribeUpstream, equalsPredicate = (a, b) => a === b) {
        return new LazySignal(initialValue, subscribeUpstream, equalsPredicate);
    }
    static createWithoutInitialValue(subscribeUpstream, equalsPredicate = (a, b) => a === b) {
        const fullEqualsPredicate = (a, b) => {
            if (a === LazySignal.NOT_AVAILABLE || b === LazySignal.NOT_AVAILABLE) {
                return a === b;
            }
            return equalsPredicate(a, b);
        };
        return new LazySignal(LazySignal.NOT_AVAILABLE, subscribeUpstream, fullEqualsPredicate);
    }
    static deriveFrom(sourceSignals, deriver, outputEqualsPredicate) {
        let fullEqualsPredicate = undefined;
        if (outputEqualsPredicate !== undefined) {
            fullEqualsPredicate = (a, b) => {
                if (a === LazySignal.NOT_AVAILABLE || b === LazySignal.NOT_AVAILABLE) {
                    return a === b;
                }
                return outputEqualsPredicate(a, b);
            };
        }
        const derive = () => {
            const sourceValues = sourceSignals.map(signal => signal.get());
            if (sourceValues.some(value => value === LazySignal.NOT_AVAILABLE)) {
                return LazySignal.NOT_AVAILABLE;
            }
            return deriver(...sourceValues);
        };
        return new LazySignal(derive(), setDownstream => {
            const unsubscriber = sourceSignals.map(signal => signal.subscribe(() => {
                const value = derive();
                if (isAvailable(value)) {
                    setDownstream(value);
                }
            }));
            const newValue = derive();
            if (isAvailable(newValue)) {
                setDownstream(newValue);
            }
            return () => {
                unsubscriber.forEach(unsub => unsub());
            };
        }, fullEqualsPredicate);
    }
    static asyncDeriveFrom(strategy, sourceSignals, deriver, outputEqualsPredicate) {
        let fullEqualsPredicate = undefined;
        if (outputEqualsPredicate !== undefined) {
            fullEqualsPredicate = (a, b) => {
                if (a === LazySignal.NOT_AVAILABLE || b === LazySignal.NOT_AVAILABLE) {
                    return a === b;
                }
                return outputEqualsPredicate(a, b);
            };
        }
        let lastAppliedUpdateId = -1;
        let lastIssuedUpdateId = -1;
        return new LazySignal(LazySignal.NOT_AVAILABLE, setDownstream => {
            const deriveAndUpdate = () => {
                lastIssuedUpdateId++;
                const updateId = lastIssuedUpdateId;
                const sourceValues = sourceSignals.map(signal => signal.get());
                if (sourceValues.some(value => value === LazySignal.NOT_AVAILABLE)) {
                    return;
                }
                deriver(...sourceValues).then(result => {
                    if (!isAvailable(result)) {
                        return;
                    }
                    switch (strategy) {
                        case "eager": {
                            if (updateId > lastAppliedUpdateId) {
                                lastAppliedUpdateId = updateId;
                                setDownstream(result);
                            }
                            break;
                        }
                        default: {
                            const exhaustiveCheck = strategy;
                            throw new Error(`Unknown strategy: ${exhaustiveCheck}`);
                        }
                    }
                });
            };
            const unsubscriber = sourceSignals.map(signal => signal.subscribe(() => {
                deriveAndUpdate();
            }));
            deriveAndUpdate();
            return () => {
                unsubscriber.forEach(unsub => unsub());
            };
        }, fullEqualsPredicate);
    }
    constructor(initialValue, subscribeUpstream, equalsPredicate = (a, b) => a === b) {
        super();
        this.subscribeUpstream = subscribeUpstream;
        this.dataIsStale = true;
        this.upstreamUnsubscribe = null;
        this.subscribersCount = 0;
        this.isSubscribedToUpstream = false;
        this.updateReceivedSynchronousCallbacks = new Set();
        [this.signal, this.setValue] = Signal.create(initialValue, equalsPredicate);
        [this.updateReceivedEvent, this.emitUpdateReceivedEvent] = Event.create();
    }
    /**
     * Returns whether the value is currently stale.
     *
     * A value is stale whenever the upstream subscription is not active. This can happen in three
     * cases:
     *
     * 1. When no subscriber is attached to this signal, the signal will not subscribe to the
     *    upstream. In this case, the value is always stale.
     * 2. When a subscriber is attached, but the upstream has not yet emitted a single value, the
     *    value is also stale.
     * 3. When the upstream has emitted an error. In this case, the subscription to the upstream is
     *    terminated and the value is stale.
     *
     * If you wish to get the current value and ensure that it is not stale, use the method
     * {@link LazySignal#pull}.
     */
    isStale() {
        return this.dataIsStale;
    }
    subscribeToUpstream() {
        this.isSubscribedToUpstream = true;
        let subscribed = true;
        let becameStale = false;
        const unsubscribeFromUpstream = this.subscribeUpstream(makeSetterWithPatches((updater, tags) => {
            if (!subscribed) {
                return;
            }
            this.setValue.withPatchUpdater(updater, tags);
            this.dataIsStale = becameStale;
            this.emitUpdateReceivedEvent();
            for (const callback of this.updateReceivedSynchronousCallbacks) {
                callback();
            }
        }), error => {
            if (!subscribed) {
                return;
            }
            Promise.reject(error); // Prints a global error for now
            this.dataIsStale = true;
            this.isSubscribedToUpstream = false;
            this.upstreamUnsubscribe = null;
            subscribed = false;
        });
        this.upstreamUnsubscribe = () => {
            if (subscribed) {
                subscribed = false;
                becameStale = true;
                unsubscribeFromUpstream();
            }
        };
    }
    unsubscribeFromUpstream() {
        this.isSubscribedToUpstream = false;
        if (this.upstreamUnsubscribe !== null) {
            this.upstreamUnsubscribe();
            this.upstreamUnsubscribe = null;
            this.dataIsStale = true;
        }
    }
    /**
     * Gets the current value of the signal. If the value is not available, it will return
     * {@link LazySignal.NOT_AVAILABLE}. (A value will only be unavailable if the signal is created
     * without an initial value and the upstream has not emitted a value yet.)
     *
     * In addition, the value returned by this method may be stale. Use {@link LazySignal#isStale} to
     * check if the value is stale.
     *
     * If you wish to get the current value and ensure that it is not stale, use the method
     * {@link LazySignal#pull}.
     */
    get() {
        return this.signal.get();
    }
    /**
     * Pulls the current value of the signal. If the value is stale, it will subscribe and wait for
     * the next value from the upstream and return it.
     */
    async pull() {
        const { promise, resolve } = makePromise();
        if (!this.isStale()) {
            // If not stale, definitely not "NOT_AVAILABLE"
            resolve(this.get());
        }
        else {
            const unsubscribe = this.subscribe(() => { });
            this.updateReceivedEvent.subscribeOnce(() => {
                resolve(this.get());
            });
            promise.then(unsubscribe);
        }
        return promise;
    }
    /**
     * If the data is not stale, the callback will be called synchronously with the current value.
     *
     * If the data is stale, it will pull the current value and call the callback with the value.
     */
    runOnNextFreshData(callback) {
        if (!this.isStale()) {
            callback(this.get());
        }
        else {
            let unsubscribe = null;
            const updateCallback = () => {
                this.updateReceivedSynchronousCallbacks.delete(updateCallback);
                callback(this.get());
                unsubscribe?.();
            };
            this.updateReceivedSynchronousCallbacks.add(updateCallback);
            unsubscribe = this.subscribe(() => { });
        }
    }
    async ensureAvailable() {
        await this.pull();
        return this;
    }
    subscribe(subscriber) {
        if (!this.isSubscribedToUpstream) {
            this.subscribeToUpstream();
        }
        this.subscribersCount++;
        const unsubscribe = this.signal.subscribe(subscriber);
        let unsubscribeCalled = false;
        return () => {
            if (unsubscribeCalled) {
                return;
            }
            unsubscribe();
            unsubscribeCalled = true;
            this.subscribersCount--;
            if (this.subscribersCount === 0 && this.isSubscribedToUpstream) {
                this.unsubscribeFromUpstream();
            }
        };
    }
    subscribeFull(subscriber) {
        if (!this.isSubscribedToUpstream) {
            this.subscribeToUpstream();
        }
        this.subscribersCount++;
        const unsubscribe = this.signal.subscribeFull(subscriber);
        let unsubscribeCalled = false;
        return () => {
            if (unsubscribeCalled) {
                return;
            }
            unsubscribe();
            unsubscribeCalled = true;
            this.subscribersCount--;
            if (this.subscribersCount === 0 && this.isSubscribedToUpstream) {
                this.unsubscribeFromUpstream();
            }
        };
    }
    /**
     * Subscribes to the signal. Will not cause the signal to subscribe to the upstream.
     */
    passiveSubscribe(subscriber) {
        return this.signal.subscribe(subscriber);
    }
    passiveSubscribeFull(subscriber) {
        return this.signal.subscribeFull(subscriber);
    }
    async until(predicate) {
        const current = this.get();
        if (isAvailable(current) && predicate(current)) {
            return current;
        }
        const { promise, resolve } = makePromise();
        const unsubscribe = this.subscribe(data => {
            if (isAvailable(data) && predicate(data)) {
                resolve(data);
                unsubscribe();
            }
        });
        return await promise;
    }
}

const apiServerPorts = [41343, 52993, 16141, 39414, 22931];

const waitForNextMicroTask = Symbol();
/**
 * A buffered event will buffer events in a queue if no subscribers are present. When a subscriber
 * is added, all buffered events will trigger sequentially in the next microtask.
 *
 * Similar to Event, events are always emitted during the next microtask.
 *
 * Attempting to add more than one subscriber will resulting in an error.
 */
class BufferedEvent extends Subscribable {
    static create() {
        const event = new BufferedEvent();
        const emitter = data => {
            event.emit(data);
        };
        return [event, emitter];
    }
    constructor() {
        super();
        this.subscriber = null;
        this.queued = [];
        this.isNotifying = false;
    }
    emit(data) {
        if (this.queued.length === 0 && this.queued.at(-1) !== waitForNextMicroTask) {
            this.queued.push(waitForNextMicroTask);
        }
        this.queued.push(data);
        if (!this.isNotifying) {
            this.notifier();
        }
    }
    async notifier() {
        this.isNotifying = true;
        while (this.subscriber !== null && this.queued.length > 0) {
            const data = this.queued.shift();
            if (data === waitForNextMicroTask) {
                await Promise.resolve();
            }
            else {
                this.subscriber(data);
            }
        }
        this.isNotifying = false;
    }
    subscribe(listener) {
        if (this.subscriber !== null) {
            throw new Error("Cannot have more than one subscriber");
        }
        this.subscriber = listener;
        if (!this.isNotifying && this.queued.length > 0) {
            this.queued = [
                waitForNextMicroTask,
                ...this.queued.filter(data => data !== waitForNextMicroTask),
            ];
            this.notifier();
        }
        return () => {
            this.subscriber = null;
        };
    }
    /**
     * Convert this buffered event to an event by stop buffering and triggering events on the new
     * returned event.
     */
    flow() {
        const [event, emit] = Event.create();
        this.subscribe(emit);
        return event;
    }
}

class CancelEvent extends Subscribable {
    constructor() {
        super(...arguments);
        this.canceled = false;
        this.listeners = new Set();
    }
    subscribe(listener) {
        if (this.canceled) {
            let callbackCanceled = false;
            Promise.resolve().then(() => {
                if (!callbackCanceled) {
                    listener();
                }
            });
            return () => {
                callbackCanceled = true;
            };
        }
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    cancel() {
        if (this.canceled) {
            throw new Error("Already canceled");
        }
        this.canceled = true;
        for (const listener of this.listeners) {
            listener();
        }
    }
    isCanceled() {
        return this.canceled;
    }
}

class Cleaner {
    constructor() {
        this.eagerCleaned = false;
        this.disposed = false;
        this.cleanups = [];
    }
    register(fn) {
        if (this.eagerCleaned) {
            throw new Error("Cannot register a cleanup after eagerClean() was called.");
        }
        if (this.disposed) {
            throw new Error("Cannot register a cleanup after the Cleaner was disposed.");
        }
        this.cleanups.push(fn);
    }
    runCleanersInternal() {
        for (const cleanup of this.cleanups) {
            cleanup();
        }
        // Just to free some memory because why not
        this.cleanups.length = 0;
    }
    [Symbol.dispose]() {
        if (this.eagerCleaned) {
            // Already eagerly cleaned. Nothing to do.
            return;
        }
        if (this.disposed) {
            throw new Error("Cannot dispose a Cleaner that was already disposed.");
        }
        this.runCleanersInternal();
    }
    eagerClean() {
        if (this.eagerCleaned) {
            throw new Error("Cannot call eagerClean() twice.");
        }
        if (this.disposed) {
            throw new Error("Cannot call eagerClean() after the Cleaner was disposed.");
        }
        this.eagerCleaned = true;
        this.runCleanersInternal();
    }
}

// Error stack manipulation related functions
function getCurrentStack(goAbove = 0) {
    const stack = new Error().stack;
    if (!stack) {
        return "";
    }
    const lines = stack.split("\n");
    return lines.slice(2 + goAbove).join("\n");
}
function changeErrorStackInPlace(error, newStack) {
    if (process$1.env.LMS_KEEP_INTERNAL_STACK) {
        return;
    }
    const stackContent = error.stack ?? "";
    error.stack = (stackContent.substring(0, stackContent.indexOf("\n    at ")).trimEnd() +
        "\n" +
        newStack).trimEnd();
}

class IdGiver {
    constructor(firstId = 0) {
        this.nextId = firstId;
    }
    next() {
        const id = this.nextId;
        this.nextId++;
        return id;
    }
}

function getDefaultExportFromCjs (x) {
	return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, 'default') ? x['default'] : x;
}

var boxen$1 = {exports: {}};

var stringWidth = {exports: {}};

var ansiRegex;
var hasRequiredAnsiRegex;

function requireAnsiRegex () {
	if (hasRequiredAnsiRegex) return ansiRegex;
	hasRequiredAnsiRegex = 1;

	ansiRegex = ({onlyFirst = false} = {}) => {
		const pattern = [
			'[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
			'(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))'
		].join('|');

		return new RegExp(pattern, onlyFirst ? undefined : 'g');
	};
	return ansiRegex;
}

var stripAnsi;
var hasRequiredStripAnsi;

function requireStripAnsi () {
	if (hasRequiredStripAnsi) return stripAnsi;
	hasRequiredStripAnsi = 1;
	const ansiRegex = requireAnsiRegex();

	stripAnsi = string => typeof string === 'string' ? string.replace(ansiRegex(), '') : string;
	return stripAnsi;
}

var isFullwidthCodePoint = {exports: {}};

/* eslint-disable yoda */

var hasRequiredIsFullwidthCodePoint;

function requireIsFullwidthCodePoint () {
	if (hasRequiredIsFullwidthCodePoint) return isFullwidthCodePoint.exports;
	hasRequiredIsFullwidthCodePoint = 1;

	const isFullwidthCodePoint$1 = codePoint => {
		if (Number.isNaN(codePoint)) {
			return false;
		}

		// Code points are derived from:
		// http://www.unix.org/Public/UNIDATA/EastAsianWidth.txt
		if (
			codePoint >= 0x1100 && (
				codePoint <= 0x115F || // Hangul Jamo
				codePoint === 0x2329 || // LEFT-POINTING ANGLE BRACKET
				codePoint === 0x232A || // RIGHT-POINTING ANGLE BRACKET
				// CJK Radicals Supplement .. Enclosed CJK Letters and Months
				(0x2E80 <= codePoint && codePoint <= 0x3247 && codePoint !== 0x303F) ||
				// Enclosed CJK Letters and Months .. CJK Unified Ideographs Extension A
				(0x3250 <= codePoint && codePoint <= 0x4DBF) ||
				// CJK Unified Ideographs .. Yi Radicals
				(0x4E00 <= codePoint && codePoint <= 0xA4C6) ||
				// Hangul Jamo Extended-A
				(0xA960 <= codePoint && codePoint <= 0xA97C) ||
				// Hangul Syllables
				(0xAC00 <= codePoint && codePoint <= 0xD7A3) ||
				// CJK Compatibility Ideographs
				(0xF900 <= codePoint && codePoint <= 0xFAFF) ||
				// Vertical Forms
				(0xFE10 <= codePoint && codePoint <= 0xFE19) ||
				// CJK Compatibility Forms .. Small Form Variants
				(0xFE30 <= codePoint && codePoint <= 0xFE6B) ||
				// Halfwidth and Fullwidth Forms
				(0xFF01 <= codePoint && codePoint <= 0xFF60) ||
				(0xFFE0 <= codePoint && codePoint <= 0xFFE6) ||
				// Kana Supplement
				(0x1B000 <= codePoint && codePoint <= 0x1B001) ||
				// Enclosed Ideographic Supplement
				(0x1F200 <= codePoint && codePoint <= 0x1F251) ||
				// CJK Unified Ideographs Extension B .. Tertiary Ideographic Plane
				(0x20000 <= codePoint && codePoint <= 0x3FFFD)
			)
		) {
			return true;
		}

		return false;
	};

	isFullwidthCodePoint.exports = isFullwidthCodePoint$1;
	isFullwidthCodePoint.exports.default = isFullwidthCodePoint$1;
	return isFullwidthCodePoint.exports;
}

var emojiRegex;
var hasRequiredEmojiRegex;

function requireEmojiRegex () {
	if (hasRequiredEmojiRegex) return emojiRegex;
	hasRequiredEmojiRegex = 1;

	emojiRegex = function () {
	  // https://mths.be/emoji
	  return /\uD83C\uDFF4\uDB40\uDC67\uDB40\uDC62(?:\uDB40\uDC65\uDB40\uDC6E\uDB40\uDC67|\uDB40\uDC73\uDB40\uDC63\uDB40\uDC74|\uDB40\uDC77\uDB40\uDC6C\uDB40\uDC73)\uDB40\uDC7F|\uD83D\uDC68(?:\uD83C\uDFFC\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68\uD83C\uDFFB|\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFF\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFB-\uDFFE])|\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFE\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFB-\uDFFD])|\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFD\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFB\uDFFC])|\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\u200D(?:\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D)?\uD83D\uDC68|(?:\uD83D[\uDC68\uDC69])\u200D(?:\uD83D\uDC66\u200D\uD83D\uDC66|\uD83D\uDC67\u200D(?:\uD83D[\uDC66\uDC67]))|\uD83D\uDC66\u200D\uD83D\uDC66|\uD83D\uDC67\u200D(?:\uD83D[\uDC66\uDC67])|(?:\uD83D[\uDC68\uDC69])\u200D(?:\uD83D[\uDC66\uDC67])|[\u2695\u2696\u2708]\uFE0F|\uD83D[\uDC66\uDC67]|\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|(?:\uD83C\uDFFB\u200D[\u2695\u2696\u2708]|\uD83C\uDFFF\u200D[\u2695\u2696\u2708]|\uD83C\uDFFE\u200D[\u2695\u2696\u2708]|\uD83C\uDFFD\u200D[\u2695\u2696\u2708]|\uD83C\uDFFC\u200D[\u2695\u2696\u2708])\uFE0F|\uD83C\uDFFB\u200D(?:\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C[\uDFFB-\uDFFF])|(?:\uD83E\uDDD1\uD83C\uDFFB\u200D\uD83E\uDD1D\u200D\uD83E\uDDD1|\uD83D\uDC69\uD83C\uDFFC\u200D\uD83E\uDD1D\u200D\uD83D\uDC69)\uD83C\uDFFB|\uD83E\uDDD1(?:\uD83C\uDFFF\u200D\uD83E\uDD1D\u200D\uD83E\uDDD1(?:\uD83C[\uDFFB-\uDFFF])|\u200D\uD83E\uDD1D\u200D\uD83E\uDDD1)|(?:\uD83E\uDDD1\uD83C\uDFFE\u200D\uD83E\uDD1D\u200D\uD83E\uDDD1|\uD83D\uDC69\uD83C\uDFFF\u200D\uD83E\uDD1D\u200D(?:\uD83D[\uDC68\uDC69]))(?:\uD83C[\uDFFB-\uDFFE])|(?:\uD83E\uDDD1\uD83C\uDFFC\u200D\uD83E\uDD1D\u200D\uD83E\uDDD1|\uD83D\uDC69\uD83C\uDFFD\u200D\uD83E\uDD1D\u200D\uD83D\uDC69)(?:\uD83C[\uDFFB\uDFFC])|\uD83D\uDC69(?:\uD83C\uDFFE\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFB-\uDFFD\uDFFF])|\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFC\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFB\uDFFD-\uDFFF])|\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFB\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFC-\uDFFF])|\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFD\u200D(?:\uD83E\uDD1D\u200D\uD83D\uDC68(?:\uD83C[\uDFFB\uDFFC\uDFFE\uDFFF])|\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\u200D(?:\u2764\uFE0F\u200D(?:\uD83D\uDC8B\u200D(?:\uD83D[\uDC68\uDC69])|\uD83D[\uDC68\uDC69])|\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD])|\uD83C\uDFFF\u200D(?:\uD83C[\uDF3E\uDF73\uDF93\uDFA4\uDFA8\uDFEB\uDFED]|\uD83D[\uDCBB\uDCBC\uDD27\uDD2C\uDE80\uDE92]|\uD83E[\uDDAF-\uDDB3\uDDBC\uDDBD]))|\uD83D\uDC69\u200D\uD83D\uDC69\u200D(?:\uD83D\uDC66\u200D\uD83D\uDC66|\uD83D\uDC67\u200D(?:\uD83D[\uDC66\uDC67]))|(?:\uD83E\uDDD1\uD83C\uDFFD\u200D\uD83E\uDD1D\u200D\uD83E\uDDD1|\uD83D\uDC69\uD83C\uDFFE\u200D\uD83E\uDD1D\u200D\uD83D\uDC69)(?:\uD83C[\uDFFB-\uDFFD])|\uD83D\uDC69\u200D\uD83D\uDC66\u200D\uD83D\uDC66|\uD83D\uDC69\u200D\uD83D\uDC69\u200D(?:\uD83D[\uDC66\uDC67])|(?:\uD83D\uDC41\uFE0F\u200D\uD83D\uDDE8|\uD83D\uDC69(?:\uD83C\uDFFF\u200D[\u2695\u2696\u2708]|\uD83C\uDFFE\u200D[\u2695\u2696\u2708]|\uD83C\uDFFC\u200D[\u2695\u2696\u2708]|\uD83C\uDFFB\u200D[\u2695\u2696\u2708]|\uD83C\uDFFD\u200D[\u2695\u2696\u2708]|\u200D[\u2695\u2696\u2708])|(?:(?:\u26F9|\uD83C[\uDFCB\uDFCC]|\uD83D\uDD75)\uFE0F|\uD83D\uDC6F|\uD83E[\uDD3C\uDDDE\uDDDF])\u200D[\u2640\u2642]|(?:\u26F9|\uD83C[\uDFCB\uDFCC]|\uD83D\uDD75)(?:\uD83C[\uDFFB-\uDFFF])\u200D[\u2640\u2642]|(?:\uD83C[\uDFC3\uDFC4\uDFCA]|\uD83D[\uDC6E\uDC71\uDC73\uDC77\uDC81\uDC82\uDC86\uDC87\uDE45-\uDE47\uDE4B\uDE4D\uDE4E\uDEA3\uDEB4-\uDEB6]|\uD83E[\uDD26\uDD37-\uDD39\uDD3D\uDD3E\uDDB8\uDDB9\uDDCD-\uDDCF\uDDD6-\uDDDD])(?:(?:\uD83C[\uDFFB-\uDFFF])\u200D[\u2640\u2642]|\u200D[\u2640\u2642])|\uD83C\uDFF4\u200D\u2620)\uFE0F|\uD83D\uDC69\u200D\uD83D\uDC67\u200D(?:\uD83D[\uDC66\uDC67])|\uD83C\uDFF3\uFE0F\u200D\uD83C\uDF08|\uD83D\uDC15\u200D\uD83E\uDDBA|\uD83D\uDC69\u200D\uD83D\uDC66|\uD83D\uDC69\u200D\uD83D\uDC67|\uD83C\uDDFD\uD83C\uDDF0|\uD83C\uDDF4\uD83C\uDDF2|\uD83C\uDDF6\uD83C\uDDE6|[#\*0-9]\uFE0F\u20E3|\uD83C\uDDE7(?:\uD83C[\uDDE6\uDDE7\uDDE9-\uDDEF\uDDF1-\uDDF4\uDDF6-\uDDF9\uDDFB\uDDFC\uDDFE\uDDFF])|\uD83C\uDDF9(?:\uD83C[\uDDE6\uDDE8\uDDE9\uDDEB-\uDDED\uDDEF-\uDDF4\uDDF7\uDDF9\uDDFB\uDDFC\uDDFF])|\uD83C\uDDEA(?:\uD83C[\uDDE6\uDDE8\uDDEA\uDDEC\uDDED\uDDF7-\uDDFA])|\uD83E\uDDD1(?:\uD83C[\uDFFB-\uDFFF])|\uD83C\uDDF7(?:\uD83C[\uDDEA\uDDF4\uDDF8\uDDFA\uDDFC])|\uD83D\uDC69(?:\uD83C[\uDFFB-\uDFFF])|\uD83C\uDDF2(?:\uD83C[\uDDE6\uDDE8-\uDDED\uDDF0-\uDDFF])|\uD83C\uDDE6(?:\uD83C[\uDDE8-\uDDEC\uDDEE\uDDF1\uDDF2\uDDF4\uDDF6-\uDDFA\uDDFC\uDDFD\uDDFF])|\uD83C\uDDF0(?:\uD83C[\uDDEA\uDDEC-\uDDEE\uDDF2\uDDF3\uDDF5\uDDF7\uDDFC\uDDFE\uDDFF])|\uD83C\uDDED(?:\uD83C[\uDDF0\uDDF2\uDDF3\uDDF7\uDDF9\uDDFA])|\uD83C\uDDE9(?:\uD83C[\uDDEA\uDDEC\uDDEF\uDDF0\uDDF2\uDDF4\uDDFF])|\uD83C\uDDFE(?:\uD83C[\uDDEA\uDDF9])|\uD83C\uDDEC(?:\uD83C[\uDDE6\uDDE7\uDDE9-\uDDEE\uDDF1-\uDDF3\uDDF5-\uDDFA\uDDFC\uDDFE])|\uD83C\uDDF8(?:\uD83C[\uDDE6-\uDDEA\uDDEC-\uDDF4\uDDF7-\uDDF9\uDDFB\uDDFD-\uDDFF])|\uD83C\uDDEB(?:\uD83C[\uDDEE-\uDDF0\uDDF2\uDDF4\uDDF7])|\uD83C\uDDF5(?:\uD83C[\uDDE6\uDDEA-\uDDED\uDDF0-\uDDF3\uDDF7-\uDDF9\uDDFC\uDDFE])|\uD83C\uDDFB(?:\uD83C[\uDDE6\uDDE8\uDDEA\uDDEC\uDDEE\uDDF3\uDDFA])|\uD83C\uDDF3(?:\uD83C[\uDDE6\uDDE8\uDDEA-\uDDEC\uDDEE\uDDF1\uDDF4\uDDF5\uDDF7\uDDFA\uDDFF])|\uD83C\uDDE8(?:\uD83C[\uDDE6\uDDE8\uDDE9\uDDEB-\uDDEE\uDDF0-\uDDF5\uDDF7\uDDFA-\uDDFF])|\uD83C\uDDF1(?:\uD83C[\uDDE6-\uDDE8\uDDEE\uDDF0\uDDF7-\uDDFB\uDDFE])|\uD83C\uDDFF(?:\uD83C[\uDDE6\uDDF2\uDDFC])|\uD83C\uDDFC(?:\uD83C[\uDDEB\uDDF8])|\uD83C\uDDFA(?:\uD83C[\uDDE6\uDDEC\uDDF2\uDDF3\uDDF8\uDDFE\uDDFF])|\uD83C\uDDEE(?:\uD83C[\uDDE8-\uDDEA\uDDF1-\uDDF4\uDDF6-\uDDF9])|\uD83C\uDDEF(?:\uD83C[\uDDEA\uDDF2\uDDF4\uDDF5])|(?:\uD83C[\uDFC3\uDFC4\uDFCA]|\uD83D[\uDC6E\uDC71\uDC73\uDC77\uDC81\uDC82\uDC86\uDC87\uDE45-\uDE47\uDE4B\uDE4D\uDE4E\uDEA3\uDEB4-\uDEB6]|\uD83E[\uDD26\uDD37-\uDD39\uDD3D\uDD3E\uDDB8\uDDB9\uDDCD-\uDDCF\uDDD6-\uDDDD])(?:\uD83C[\uDFFB-\uDFFF])|(?:\u26F9|\uD83C[\uDFCB\uDFCC]|\uD83D\uDD75)(?:\uD83C[\uDFFB-\uDFFF])|(?:[\u261D\u270A-\u270D]|\uD83C[\uDF85\uDFC2\uDFC7]|\uD83D[\uDC42\uDC43\uDC46-\uDC50\uDC66\uDC67\uDC6B-\uDC6D\uDC70\uDC72\uDC74-\uDC76\uDC78\uDC7C\uDC83\uDC85\uDCAA\uDD74\uDD7A\uDD90\uDD95\uDD96\uDE4C\uDE4F\uDEC0\uDECC]|\uD83E[\uDD0F\uDD18-\uDD1C\uDD1E\uDD1F\uDD30-\uDD36\uDDB5\uDDB6\uDDBB\uDDD2-\uDDD5])(?:\uD83C[\uDFFB-\uDFFF])|(?:[\u231A\u231B\u23E9-\u23EC\u23F0\u23F3\u25FD\u25FE\u2614\u2615\u2648-\u2653\u267F\u2693\u26A1\u26AA\u26AB\u26BD\u26BE\u26C4\u26C5\u26CE\u26D4\u26EA\u26F2\u26F3\u26F5\u26FA\u26FD\u2705\u270A\u270B\u2728\u274C\u274E\u2753-\u2755\u2757\u2795-\u2797\u27B0\u27BF\u2B1B\u2B1C\u2B50\u2B55]|\uD83C[\uDC04\uDCCF\uDD8E\uDD91-\uDD9A\uDDE6-\uDDFF\uDE01\uDE1A\uDE2F\uDE32-\uDE36\uDE38-\uDE3A\uDE50\uDE51\uDF00-\uDF20\uDF2D-\uDF35\uDF37-\uDF7C\uDF7E-\uDF93\uDFA0-\uDFCA\uDFCF-\uDFD3\uDFE0-\uDFF0\uDFF4\uDFF8-\uDFFF]|\uD83D[\uDC00-\uDC3E\uDC40\uDC42-\uDCFC\uDCFF-\uDD3D\uDD4B-\uDD4E\uDD50-\uDD67\uDD7A\uDD95\uDD96\uDDA4\uDDFB-\uDE4F\uDE80-\uDEC5\uDECC\uDED0-\uDED2\uDED5\uDEEB\uDEEC\uDEF4-\uDEFA\uDFE0-\uDFEB]|\uD83E[\uDD0D-\uDD3A\uDD3C-\uDD45\uDD47-\uDD71\uDD73-\uDD76\uDD7A-\uDDA2\uDDA5-\uDDAA\uDDAE-\uDDCA\uDDCD-\uDDFF\uDE70-\uDE73\uDE78-\uDE7A\uDE80-\uDE82\uDE90-\uDE95])|(?:[#\*0-9\xA9\xAE\u203C\u2049\u2122\u2139\u2194-\u2199\u21A9\u21AA\u231A\u231B\u2328\u23CF\u23E9-\u23F3\u23F8-\u23FA\u24C2\u25AA\u25AB\u25B6\u25C0\u25FB-\u25FE\u2600-\u2604\u260E\u2611\u2614\u2615\u2618\u261D\u2620\u2622\u2623\u2626\u262A\u262E\u262F\u2638-\u263A\u2640\u2642\u2648-\u2653\u265F\u2660\u2663\u2665\u2666\u2668\u267B\u267E\u267F\u2692-\u2697\u2699\u269B\u269C\u26A0\u26A1\u26AA\u26AB\u26B0\u26B1\u26BD\u26BE\u26C4\u26C5\u26C8\u26CE\u26CF\u26D1\u26D3\u26D4\u26E9\u26EA\u26F0-\u26F5\u26F7-\u26FA\u26FD\u2702\u2705\u2708-\u270D\u270F\u2712\u2714\u2716\u271D\u2721\u2728\u2733\u2734\u2744\u2747\u274C\u274E\u2753-\u2755\u2757\u2763\u2764\u2795-\u2797\u27A1\u27B0\u27BF\u2934\u2935\u2B05-\u2B07\u2B1B\u2B1C\u2B50\u2B55\u3030\u303D\u3297\u3299]|\uD83C[\uDC04\uDCCF\uDD70\uDD71\uDD7E\uDD7F\uDD8E\uDD91-\uDD9A\uDDE6-\uDDFF\uDE01\uDE02\uDE1A\uDE2F\uDE32-\uDE3A\uDE50\uDE51\uDF00-\uDF21\uDF24-\uDF93\uDF96\uDF97\uDF99-\uDF9B\uDF9E-\uDFF0\uDFF3-\uDFF5\uDFF7-\uDFFF]|\uD83D[\uDC00-\uDCFD\uDCFF-\uDD3D\uDD49-\uDD4E\uDD50-\uDD67\uDD6F\uDD70\uDD73-\uDD7A\uDD87\uDD8A-\uDD8D\uDD90\uDD95\uDD96\uDDA4\uDDA5\uDDA8\uDDB1\uDDB2\uDDBC\uDDC2-\uDDC4\uDDD1-\uDDD3\uDDDC-\uDDDE\uDDE1\uDDE3\uDDE8\uDDEF\uDDF3\uDDFA-\uDE4F\uDE80-\uDEC5\uDECB-\uDED2\uDED5\uDEE0-\uDEE5\uDEE9\uDEEB\uDEEC\uDEF0\uDEF3-\uDEFA\uDFE0-\uDFEB]|\uD83E[\uDD0D-\uDD3A\uDD3C-\uDD45\uDD47-\uDD71\uDD73-\uDD76\uDD7A-\uDDA2\uDDA5-\uDDAA\uDDAE-\uDDCA\uDDCD-\uDDFF\uDE70-\uDE73\uDE78-\uDE7A\uDE80-\uDE82\uDE90-\uDE95])\uFE0F|(?:[\u261D\u26F9\u270A-\u270D]|\uD83C[\uDF85\uDFC2-\uDFC4\uDFC7\uDFCA-\uDFCC]|\uD83D[\uDC42\uDC43\uDC46-\uDC50\uDC66-\uDC78\uDC7C\uDC81-\uDC83\uDC85-\uDC87\uDC8F\uDC91\uDCAA\uDD74\uDD75\uDD7A\uDD90\uDD95\uDD96\uDE45-\uDE47\uDE4B-\uDE4F\uDEA3\uDEB4-\uDEB6\uDEC0\uDECC]|\uD83E[\uDD0F\uDD18-\uDD1F\uDD26\uDD30-\uDD39\uDD3C-\uDD3E\uDDB5\uDDB6\uDDB8\uDDB9\uDDBB\uDDCD-\uDDCF\uDDD1-\uDDDD])/g;
	};
	return emojiRegex;
}

var hasRequiredStringWidth;

function requireStringWidth () {
	if (hasRequiredStringWidth) return stringWidth.exports;
	hasRequiredStringWidth = 1;
	const stripAnsi = requireStripAnsi();
	const isFullwidthCodePoint = requireIsFullwidthCodePoint();
	const emojiRegex = requireEmojiRegex();

	const stringWidth$1 = string => {
		if (typeof string !== 'string' || string.length === 0) {
			return 0;
		}

		string = stripAnsi(string);

		if (string.length === 0) {
			return 0;
		}

		string = string.replace(emojiRegex(), '  ');

		let width = 0;

		for (let i = 0; i < string.length; i++) {
			const code = string.codePointAt(i);

			// Ignore control characters
			if (code <= 0x1F || (code >= 0x7F && code <= 0x9F)) {
				continue;
			}

			// Ignore combining characters
			if (code >= 0x300 && code <= 0x36F) {
				continue;
			}

			// Surrogates
			if (code > 0xFFFF) {
				i++;
			}

			width += isFullwidthCodePoint(code) ? 2 : 1;
		}

		return width;
	};

	stringWidth.exports = stringWidth$1;
	// TODO: remove this in the next major version
	stringWidth.exports.default = stringWidth$1;
	return stringWidth.exports;
}

var widestLine = {exports: {}};

var hasRequiredWidestLine;

function requireWidestLine () {
	if (hasRequiredWidestLine) return widestLine.exports;
	hasRequiredWidestLine = 1;
	const stringWidth = requireStringWidth();

	const widestLine$1 = input => {
		let max = 0;

		for (const line of input.split('\n')) {
			max = Math.max(max, stringWidth(line));
		}

		return max;
	};

	widestLine.exports = widestLine$1;
	// TODO: remove this in the next major version
	widestLine.exports.default = widestLine$1;
	return widestLine.exports;
}

var cliBoxes = {exports: {}};

var single = {
	topLeft: "┌",
	topRight: "┐",
	bottomRight: "┘",
	bottomLeft: "└",
	vertical: "│",
	horizontal: "─"
};
var double = {
	topLeft: "╔",
	topRight: "╗",
	bottomRight: "╝",
	bottomLeft: "╚",
	vertical: "║",
	horizontal: "═"
};
var round = {
	topLeft: "╭",
	topRight: "╮",
	bottomRight: "╯",
	bottomLeft: "╰",
	vertical: "│",
	horizontal: "─"
};
var bold = {
	topLeft: "┏",
	topRight: "┓",
	bottomRight: "┛",
	bottomLeft: "┗",
	vertical: "┃",
	horizontal: "━"
};
var singleDouble = {
	topLeft: "╓",
	topRight: "╖",
	bottomRight: "╜",
	bottomLeft: "╙",
	vertical: "║",
	horizontal: "─"
};
var doubleSingle = {
	topLeft: "╒",
	topRight: "╕",
	bottomRight: "╛",
	bottomLeft: "╘",
	vertical: "│",
	horizontal: "═"
};
var classic = {
	topLeft: "+",
	topRight: "+",
	bottomRight: "+",
	bottomLeft: "+",
	vertical: "|",
	horizontal: "-"
};
var require$$0 = {
	single: single,
	double: double,
	round: round,
	bold: bold,
	singleDouble: singleDouble,
	doubleSingle: doubleSingle,
	classic: classic
};

var hasRequiredCliBoxes;

function requireCliBoxes () {
	if (hasRequiredCliBoxes) return cliBoxes.exports;
	hasRequiredCliBoxes = 1;
	const cliBoxes$1 = require$$0;

	cliBoxes.exports = cliBoxes$1;
	// TODO: Remove this for the next major release
	cliBoxes.exports.default = cliBoxes$1;
	return cliBoxes.exports;
}

var camelcase = {exports: {}};

var hasRequiredCamelcase;

function requireCamelcase () {
	if (hasRequiredCamelcase) return camelcase.exports;
	hasRequiredCamelcase = 1;

	const UPPERCASE = /[\p{Lu}]/u;
	const LOWERCASE = /[\p{Ll}]/u;
	const LEADING_CAPITAL = /^[\p{Lu}](?![\p{Lu}])/gu;
	const IDENTIFIER = /([\p{Alpha}\p{N}_]|$)/u;
	const SEPARATORS = /[_.\- ]+/;

	const LEADING_SEPARATORS = new RegExp('^' + SEPARATORS.source);
	const SEPARATORS_AND_IDENTIFIER = new RegExp(SEPARATORS.source + IDENTIFIER.source, 'gu');
	const NUMBERS_AND_IDENTIFIER = new RegExp('\\d+' + IDENTIFIER.source, 'gu');

	const preserveCamelCase = (string, toLowerCase, toUpperCase) => {
		let isLastCharLower = false;
		let isLastCharUpper = false;
		let isLastLastCharUpper = false;

		for (let i = 0; i < string.length; i++) {
			const character = string[i];

			if (isLastCharLower && UPPERCASE.test(character)) {
				string = string.slice(0, i) + '-' + string.slice(i);
				isLastCharLower = false;
				isLastLastCharUpper = isLastCharUpper;
				isLastCharUpper = true;
				i++;
			} else if (isLastCharUpper && isLastLastCharUpper && LOWERCASE.test(character)) {
				string = string.slice(0, i - 1) + '-' + string.slice(i - 1);
				isLastLastCharUpper = isLastCharUpper;
				isLastCharUpper = false;
				isLastCharLower = true;
			} else {
				isLastCharLower = toLowerCase(character) === character && toUpperCase(character) !== character;
				isLastLastCharUpper = isLastCharUpper;
				isLastCharUpper = toUpperCase(character) === character && toLowerCase(character) !== character;
			}
		}

		return string;
	};

	const preserveConsecutiveUppercase = (input, toLowerCase) => {
		LEADING_CAPITAL.lastIndex = 0;

		return input.replace(LEADING_CAPITAL, m1 => toLowerCase(m1));
	};

	const postProcess = (input, toUpperCase) => {
		SEPARATORS_AND_IDENTIFIER.lastIndex = 0;
		NUMBERS_AND_IDENTIFIER.lastIndex = 0;

		return input.replace(SEPARATORS_AND_IDENTIFIER, (_, identifier) => toUpperCase(identifier))
			.replace(NUMBERS_AND_IDENTIFIER, m => toUpperCase(m));
	};

	const camelCase = (input, options) => {
		if (!(typeof input === 'string' || Array.isArray(input))) {
			throw new TypeError('Expected the input to be `string | string[]`');
		}

		options = {
			pascalCase: false,
			preserveConsecutiveUppercase: false,
			...options
		};

		if (Array.isArray(input)) {
			input = input.map(x => x.trim())
				.filter(x => x.length)
				.join('-');
		} else {
			input = input.trim();
		}

		if (input.length === 0) {
			return '';
		}

		const toLowerCase = options.locale === false ?
			string => string.toLowerCase() :
			string => string.toLocaleLowerCase(options.locale);
		const toUpperCase = options.locale === false ?
			string => string.toUpperCase() :
			string => string.toLocaleUpperCase(options.locale);

		if (input.length === 1) {
			return options.pascalCase ? toUpperCase(input) : toLowerCase(input);
		}

		const hasUpperCase = input !== toLowerCase(input);

		if (hasUpperCase) {
			input = preserveCamelCase(input, toLowerCase, toUpperCase);
		}

		input = input.replace(LEADING_SEPARATORS, '');

		if (options.preserveConsecutiveUppercase) {
			input = preserveConsecutiveUppercase(input, toLowerCase);
		} else {
			input = toLowerCase(input);
		}

		if (options.pascalCase) {
			input = toUpperCase(input.charAt(0)) + input.slice(1);
		}

		return postProcess(input, toUpperCase);
	};

	camelcase.exports = camelCase;
	// TODO: Remove this for the next major release
	camelcase.exports.default = camelCase;
	return camelcase.exports;
}

var ansiAlign_1;
var hasRequiredAnsiAlign;

function requireAnsiAlign () {
	if (hasRequiredAnsiAlign) return ansiAlign_1;
	hasRequiredAnsiAlign = 1;

	const stringWidth = requireStringWidth();

	function ansiAlign (text, opts) {
	  if (!text) return text

	  opts = opts || {};
	  const align = opts.align || 'center';

	  // short-circuit `align: 'left'` as no-op
	  if (align === 'left') return text

	  const split = opts.split || '\n';
	  const pad = opts.pad || ' ';
	  const widthDiffFn = align !== 'right' ? halfDiff : fullDiff;

	  let returnString = false;
	  if (!Array.isArray(text)) {
	    returnString = true;
	    text = String(text).split(split);
	  }

	  let width;
	  let maxWidth = 0;
	  text = text.map(function (str) {
	    str = String(str);
	    width = stringWidth(str);
	    maxWidth = Math.max(width, maxWidth);
	    return {
	      str,
	      width
	    }
	  }).map(function (obj) {
	    return new Array(widthDiffFn(maxWidth, obj.width) + 1).join(pad) + obj.str
	  });

	  return returnString ? text.join(split) : text
	}

	ansiAlign.left = function left (text) {
	  return ansiAlign(text, { align: 'left' })
	};

	ansiAlign.center = function center (text) {
	  return ansiAlign(text, { align: 'center' })
	};

	ansiAlign.right = function right (text) {
	  return ansiAlign(text, { align: 'right' })
	};

	ansiAlign_1 = ansiAlign;

	function halfDiff (maxWidth, curWidth) {
	  return Math.floor((maxWidth - curWidth) / 2)
	}

	function fullDiff (maxWidth, curWidth) {
	  return maxWidth - curWidth
	}
	return ansiAlign_1;
}

var ansiStyles = {exports: {}};

var colorName;
var hasRequiredColorName;

function requireColorName () {
	if (hasRequiredColorName) return colorName;
	hasRequiredColorName = 1;

	colorName = {
		"aliceblue": [240, 248, 255],
		"antiquewhite": [250, 235, 215],
		"aqua": [0, 255, 255],
		"aquamarine": [127, 255, 212],
		"azure": [240, 255, 255],
		"beige": [245, 245, 220],
		"bisque": [255, 228, 196],
		"black": [0, 0, 0],
		"blanchedalmond": [255, 235, 205],
		"blue": [0, 0, 255],
		"blueviolet": [138, 43, 226],
		"brown": [165, 42, 42],
		"burlywood": [222, 184, 135],
		"cadetblue": [95, 158, 160],
		"chartreuse": [127, 255, 0],
		"chocolate": [210, 105, 30],
		"coral": [255, 127, 80],
		"cornflowerblue": [100, 149, 237],
		"cornsilk": [255, 248, 220],
		"crimson": [220, 20, 60],
		"cyan": [0, 255, 255],
		"darkblue": [0, 0, 139],
		"darkcyan": [0, 139, 139],
		"darkgoldenrod": [184, 134, 11],
		"darkgray": [169, 169, 169],
		"darkgreen": [0, 100, 0],
		"darkgrey": [169, 169, 169],
		"darkkhaki": [189, 183, 107],
		"darkmagenta": [139, 0, 139],
		"darkolivegreen": [85, 107, 47],
		"darkorange": [255, 140, 0],
		"darkorchid": [153, 50, 204],
		"darkred": [139, 0, 0],
		"darksalmon": [233, 150, 122],
		"darkseagreen": [143, 188, 143],
		"darkslateblue": [72, 61, 139],
		"darkslategray": [47, 79, 79],
		"darkslategrey": [47, 79, 79],
		"darkturquoise": [0, 206, 209],
		"darkviolet": [148, 0, 211],
		"deeppink": [255, 20, 147],
		"deepskyblue": [0, 191, 255],
		"dimgray": [105, 105, 105],
		"dimgrey": [105, 105, 105],
		"dodgerblue": [30, 144, 255],
		"firebrick": [178, 34, 34],
		"floralwhite": [255, 250, 240],
		"forestgreen": [34, 139, 34],
		"fuchsia": [255, 0, 255],
		"gainsboro": [220, 220, 220],
		"ghostwhite": [248, 248, 255],
		"gold": [255, 215, 0],
		"goldenrod": [218, 165, 32],
		"gray": [128, 128, 128],
		"green": [0, 128, 0],
		"greenyellow": [173, 255, 47],
		"grey": [128, 128, 128],
		"honeydew": [240, 255, 240],
		"hotpink": [255, 105, 180],
		"indianred": [205, 92, 92],
		"indigo": [75, 0, 130],
		"ivory": [255, 255, 240],
		"khaki": [240, 230, 140],
		"lavender": [230, 230, 250],
		"lavenderblush": [255, 240, 245],
		"lawngreen": [124, 252, 0],
		"lemonchiffon": [255, 250, 205],
		"lightblue": [173, 216, 230],
		"lightcoral": [240, 128, 128],
		"lightcyan": [224, 255, 255],
		"lightgoldenrodyellow": [250, 250, 210],
		"lightgray": [211, 211, 211],
		"lightgreen": [144, 238, 144],
		"lightgrey": [211, 211, 211],
		"lightpink": [255, 182, 193],
		"lightsalmon": [255, 160, 122],
		"lightseagreen": [32, 178, 170],
		"lightskyblue": [135, 206, 250],
		"lightslategray": [119, 136, 153],
		"lightslategrey": [119, 136, 153],
		"lightsteelblue": [176, 196, 222],
		"lightyellow": [255, 255, 224],
		"lime": [0, 255, 0],
		"limegreen": [50, 205, 50],
		"linen": [250, 240, 230],
		"magenta": [255, 0, 255],
		"maroon": [128, 0, 0],
		"mediumaquamarine": [102, 205, 170],
		"mediumblue": [0, 0, 205],
		"mediumorchid": [186, 85, 211],
		"mediumpurple": [147, 112, 219],
		"mediumseagreen": [60, 179, 113],
		"mediumslateblue": [123, 104, 238],
		"mediumspringgreen": [0, 250, 154],
		"mediumturquoise": [72, 209, 204],
		"mediumvioletred": [199, 21, 133],
		"midnightblue": [25, 25, 112],
		"mintcream": [245, 255, 250],
		"mistyrose": [255, 228, 225],
		"moccasin": [255, 228, 181],
		"navajowhite": [255, 222, 173],
		"navy": [0, 0, 128],
		"oldlace": [253, 245, 230],
		"olive": [128, 128, 0],
		"olivedrab": [107, 142, 35],
		"orange": [255, 165, 0],
		"orangered": [255, 69, 0],
		"orchid": [218, 112, 214],
		"palegoldenrod": [238, 232, 170],
		"palegreen": [152, 251, 152],
		"paleturquoise": [175, 238, 238],
		"palevioletred": [219, 112, 147],
		"papayawhip": [255, 239, 213],
		"peachpuff": [255, 218, 185],
		"peru": [205, 133, 63],
		"pink": [255, 192, 203],
		"plum": [221, 160, 221],
		"powderblue": [176, 224, 230],
		"purple": [128, 0, 128],
		"rebeccapurple": [102, 51, 153],
		"red": [255, 0, 0],
		"rosybrown": [188, 143, 143],
		"royalblue": [65, 105, 225],
		"saddlebrown": [139, 69, 19],
		"salmon": [250, 128, 114],
		"sandybrown": [244, 164, 96],
		"seagreen": [46, 139, 87],
		"seashell": [255, 245, 238],
		"sienna": [160, 82, 45],
		"silver": [192, 192, 192],
		"skyblue": [135, 206, 235],
		"slateblue": [106, 90, 205],
		"slategray": [112, 128, 144],
		"slategrey": [112, 128, 144],
		"snow": [255, 250, 250],
		"springgreen": [0, 255, 127],
		"steelblue": [70, 130, 180],
		"tan": [210, 180, 140],
		"teal": [0, 128, 128],
		"thistle": [216, 191, 216],
		"tomato": [255, 99, 71],
		"turquoise": [64, 224, 208],
		"violet": [238, 130, 238],
		"wheat": [245, 222, 179],
		"white": [255, 255, 255],
		"whitesmoke": [245, 245, 245],
		"yellow": [255, 255, 0],
		"yellowgreen": [154, 205, 50]
	};
	return colorName;
}

/* MIT license */

var conversions;
var hasRequiredConversions;

function requireConversions () {
	if (hasRequiredConversions) return conversions;
	hasRequiredConversions = 1;
	/* eslint-disable no-mixed-operators */
	const cssKeywords = requireColorName();

	// NOTE: conversions should only return primitive values (i.e. arrays, or
	//       values that give correct `typeof` results).
	//       do not use box values types (i.e. Number(), String(), etc.)

	const reverseKeywords = {};
	for (const key of Object.keys(cssKeywords)) {
		reverseKeywords[cssKeywords[key]] = key;
	}

	const convert = {
		rgb: {channels: 3, labels: 'rgb'},
		hsl: {channels: 3, labels: 'hsl'},
		hsv: {channels: 3, labels: 'hsv'},
		hwb: {channels: 3, labels: 'hwb'},
		cmyk: {channels: 4, labels: 'cmyk'},
		xyz: {channels: 3, labels: 'xyz'},
		lab: {channels: 3, labels: 'lab'},
		lch: {channels: 3, labels: 'lch'},
		hex: {channels: 1, labels: ['hex']},
		keyword: {channels: 1, labels: ['keyword']},
		ansi16: {channels: 1, labels: ['ansi16']},
		ansi256: {channels: 1, labels: ['ansi256']},
		hcg: {channels: 3, labels: ['h', 'c', 'g']},
		apple: {channels: 3, labels: ['r16', 'g16', 'b16']},
		gray: {channels: 1, labels: ['gray']}
	};

	conversions = convert;

	// Hide .channels and .labels properties
	for (const model of Object.keys(convert)) {
		if (!('channels' in convert[model])) {
			throw new Error('missing channels property: ' + model);
		}

		if (!('labels' in convert[model])) {
			throw new Error('missing channel labels property: ' + model);
		}

		if (convert[model].labels.length !== convert[model].channels) {
			throw new Error('channel and label counts mismatch: ' + model);
		}

		const {channels, labels} = convert[model];
		delete convert[model].channels;
		delete convert[model].labels;
		Object.defineProperty(convert[model], 'channels', {value: channels});
		Object.defineProperty(convert[model], 'labels', {value: labels});
	}

	convert.rgb.hsl = function (rgb) {
		const r = rgb[0] / 255;
		const g = rgb[1] / 255;
		const b = rgb[2] / 255;
		const min = Math.min(r, g, b);
		const max = Math.max(r, g, b);
		const delta = max - min;
		let h;
		let s;

		if (max === min) {
			h = 0;
		} else if (r === max) {
			h = (g - b) / delta;
		} else if (g === max) {
			h = 2 + (b - r) / delta;
		} else if (b === max) {
			h = 4 + (r - g) / delta;
		}

		h = Math.min(h * 60, 360);

		if (h < 0) {
			h += 360;
		}

		const l = (min + max) / 2;

		if (max === min) {
			s = 0;
		} else if (l <= 0.5) {
			s = delta / (max + min);
		} else {
			s = delta / (2 - max - min);
		}

		return [h, s * 100, l * 100];
	};

	convert.rgb.hsv = function (rgb) {
		let rdif;
		let gdif;
		let bdif;
		let h;
		let s;

		const r = rgb[0] / 255;
		const g = rgb[1] / 255;
		const b = rgb[2] / 255;
		const v = Math.max(r, g, b);
		const diff = v - Math.min(r, g, b);
		const diffc = function (c) {
			return (v - c) / 6 / diff + 1 / 2;
		};

		if (diff === 0) {
			h = 0;
			s = 0;
		} else {
			s = diff / v;
			rdif = diffc(r);
			gdif = diffc(g);
			bdif = diffc(b);

			if (r === v) {
				h = bdif - gdif;
			} else if (g === v) {
				h = (1 / 3) + rdif - bdif;
			} else if (b === v) {
				h = (2 / 3) + gdif - rdif;
			}

			if (h < 0) {
				h += 1;
			} else if (h > 1) {
				h -= 1;
			}
		}

		return [
			h * 360,
			s * 100,
			v * 100
		];
	};

	convert.rgb.hwb = function (rgb) {
		const r = rgb[0];
		const g = rgb[1];
		let b = rgb[2];
		const h = convert.rgb.hsl(rgb)[0];
		const w = 1 / 255 * Math.min(r, Math.min(g, b));

		b = 1 - 1 / 255 * Math.max(r, Math.max(g, b));

		return [h, w * 100, b * 100];
	};

	convert.rgb.cmyk = function (rgb) {
		const r = rgb[0] / 255;
		const g = rgb[1] / 255;
		const b = rgb[2] / 255;

		const k = Math.min(1 - r, 1 - g, 1 - b);
		const c = (1 - r - k) / (1 - k) || 0;
		const m = (1 - g - k) / (1 - k) || 0;
		const y = (1 - b - k) / (1 - k) || 0;

		return [c * 100, m * 100, y * 100, k * 100];
	};

	function comparativeDistance(x, y) {
		/*
			See https://en.m.wikipedia.org/wiki/Euclidean_distance#Squared_Euclidean_distance
		*/
		return (
			((x[0] - y[0]) ** 2) +
			((x[1] - y[1]) ** 2) +
			((x[2] - y[2]) ** 2)
		);
	}

	convert.rgb.keyword = function (rgb) {
		const reversed = reverseKeywords[rgb];
		if (reversed) {
			return reversed;
		}

		let currentClosestDistance = Infinity;
		let currentClosestKeyword;

		for (const keyword of Object.keys(cssKeywords)) {
			const value = cssKeywords[keyword];

			// Compute comparative distance
			const distance = comparativeDistance(rgb, value);

			// Check if its less, if so set as closest
			if (distance < currentClosestDistance) {
				currentClosestDistance = distance;
				currentClosestKeyword = keyword;
			}
		}

		return currentClosestKeyword;
	};

	convert.keyword.rgb = function (keyword) {
		return cssKeywords[keyword];
	};

	convert.rgb.xyz = function (rgb) {
		let r = rgb[0] / 255;
		let g = rgb[1] / 255;
		let b = rgb[2] / 255;

		// Assume sRGB
		r = r > 0.04045 ? (((r + 0.055) / 1.055) ** 2.4) : (r / 12.92);
		g = g > 0.04045 ? (((g + 0.055) / 1.055) ** 2.4) : (g / 12.92);
		b = b > 0.04045 ? (((b + 0.055) / 1.055) ** 2.4) : (b / 12.92);

		const x = (r * 0.4124) + (g * 0.3576) + (b * 0.1805);
		const y = (r * 0.2126) + (g * 0.7152) + (b * 0.0722);
		const z = (r * 0.0193) + (g * 0.1192) + (b * 0.9505);

		return [x * 100, y * 100, z * 100];
	};

	convert.rgb.lab = function (rgb) {
		const xyz = convert.rgb.xyz(rgb);
		let x = xyz[0];
		let y = xyz[1];
		let z = xyz[2];

		x /= 95.047;
		y /= 100;
		z /= 108.883;

		x = x > 0.008856 ? (x ** (1 / 3)) : (7.787 * x) + (16 / 116);
		y = y > 0.008856 ? (y ** (1 / 3)) : (7.787 * y) + (16 / 116);
		z = z > 0.008856 ? (z ** (1 / 3)) : (7.787 * z) + (16 / 116);

		const l = (116 * y) - 16;
		const a = 500 * (x - y);
		const b = 200 * (y - z);

		return [l, a, b];
	};

	convert.hsl.rgb = function (hsl) {
		const h = hsl[0] / 360;
		const s = hsl[1] / 100;
		const l = hsl[2] / 100;
		let t2;
		let t3;
		let val;

		if (s === 0) {
			val = l * 255;
			return [val, val, val];
		}

		if (l < 0.5) {
			t2 = l * (1 + s);
		} else {
			t2 = l + s - l * s;
		}

		const t1 = 2 * l - t2;

		const rgb = [0, 0, 0];
		for (let i = 0; i < 3; i++) {
			t3 = h + 1 / 3 * -(i - 1);
			if (t3 < 0) {
				t3++;
			}

			if (t3 > 1) {
				t3--;
			}

			if (6 * t3 < 1) {
				val = t1 + (t2 - t1) * 6 * t3;
			} else if (2 * t3 < 1) {
				val = t2;
			} else if (3 * t3 < 2) {
				val = t1 + (t2 - t1) * (2 / 3 - t3) * 6;
			} else {
				val = t1;
			}

			rgb[i] = val * 255;
		}

		return rgb;
	};

	convert.hsl.hsv = function (hsl) {
		const h = hsl[0];
		let s = hsl[1] / 100;
		let l = hsl[2] / 100;
		let smin = s;
		const lmin = Math.max(l, 0.01);

		l *= 2;
		s *= (l <= 1) ? l : 2 - l;
		smin *= lmin <= 1 ? lmin : 2 - lmin;
		const v = (l + s) / 2;
		const sv = l === 0 ? (2 * smin) / (lmin + smin) : (2 * s) / (l + s);

		return [h, sv * 100, v * 100];
	};

	convert.hsv.rgb = function (hsv) {
		const h = hsv[0] / 60;
		const s = hsv[1] / 100;
		let v = hsv[2] / 100;
		const hi = Math.floor(h) % 6;

		const f = h - Math.floor(h);
		const p = 255 * v * (1 - s);
		const q = 255 * v * (1 - (s * f));
		const t = 255 * v * (1 - (s * (1 - f)));
		v *= 255;

		switch (hi) {
			case 0:
				return [v, t, p];
			case 1:
				return [q, v, p];
			case 2:
				return [p, v, t];
			case 3:
				return [p, q, v];
			case 4:
				return [t, p, v];
			case 5:
				return [v, p, q];
		}
	};

	convert.hsv.hsl = function (hsv) {
		const h = hsv[0];
		const s = hsv[1] / 100;
		const v = hsv[2] / 100;
		const vmin = Math.max(v, 0.01);
		let sl;
		let l;

		l = (2 - s) * v;
		const lmin = (2 - s) * vmin;
		sl = s * vmin;
		sl /= (lmin <= 1) ? lmin : 2 - lmin;
		sl = sl || 0;
		l /= 2;

		return [h, sl * 100, l * 100];
	};

	// http://dev.w3.org/csswg/css-color/#hwb-to-rgb
	convert.hwb.rgb = function (hwb) {
		const h = hwb[0] / 360;
		let wh = hwb[1] / 100;
		let bl = hwb[2] / 100;
		const ratio = wh + bl;
		let f;

		// Wh + bl cant be > 1
		if (ratio > 1) {
			wh /= ratio;
			bl /= ratio;
		}

		const i = Math.floor(6 * h);
		const v = 1 - bl;
		f = 6 * h - i;

		if ((i & 0x01) !== 0) {
			f = 1 - f;
		}

		const n = wh + f * (v - wh); // Linear interpolation

		let r;
		let g;
		let b;
		/* eslint-disable max-statements-per-line,no-multi-spaces */
		switch (i) {
			default:
			case 6:
			case 0: r = v;  g = n;  b = wh; break;
			case 1: r = n;  g = v;  b = wh; break;
			case 2: r = wh; g = v;  b = n; break;
			case 3: r = wh; g = n;  b = v; break;
			case 4: r = n;  g = wh; b = v; break;
			case 5: r = v;  g = wh; b = n; break;
		}
		/* eslint-enable max-statements-per-line,no-multi-spaces */

		return [r * 255, g * 255, b * 255];
	};

	convert.cmyk.rgb = function (cmyk) {
		const c = cmyk[0] / 100;
		const m = cmyk[1] / 100;
		const y = cmyk[2] / 100;
		const k = cmyk[3] / 100;

		const r = 1 - Math.min(1, c * (1 - k) + k);
		const g = 1 - Math.min(1, m * (1 - k) + k);
		const b = 1 - Math.min(1, y * (1 - k) + k);

		return [r * 255, g * 255, b * 255];
	};

	convert.xyz.rgb = function (xyz) {
		const x = xyz[0] / 100;
		const y = xyz[1] / 100;
		const z = xyz[2] / 100;
		let r;
		let g;
		let b;

		r = (x * 3.2406) + (y * -1.5372) + (z * -0.4986);
		g = (x * -0.9689) + (y * 1.8758) + (z * 0.0415);
		b = (x * 0.0557) + (y * -0.2040) + (z * 1.0570);

		// Assume sRGB
		r = r > 0.0031308
			? ((1.055 * (r ** (1.0 / 2.4))) - 0.055)
			: r * 12.92;

		g = g > 0.0031308
			? ((1.055 * (g ** (1.0 / 2.4))) - 0.055)
			: g * 12.92;

		b = b > 0.0031308
			? ((1.055 * (b ** (1.0 / 2.4))) - 0.055)
			: b * 12.92;

		r = Math.min(Math.max(0, r), 1);
		g = Math.min(Math.max(0, g), 1);
		b = Math.min(Math.max(0, b), 1);

		return [r * 255, g * 255, b * 255];
	};

	convert.xyz.lab = function (xyz) {
		let x = xyz[0];
		let y = xyz[1];
		let z = xyz[2];

		x /= 95.047;
		y /= 100;
		z /= 108.883;

		x = x > 0.008856 ? (x ** (1 / 3)) : (7.787 * x) + (16 / 116);
		y = y > 0.008856 ? (y ** (1 / 3)) : (7.787 * y) + (16 / 116);
		z = z > 0.008856 ? (z ** (1 / 3)) : (7.787 * z) + (16 / 116);

		const l = (116 * y) - 16;
		const a = 500 * (x - y);
		const b = 200 * (y - z);

		return [l, a, b];
	};

	convert.lab.xyz = function (lab) {
		const l = lab[0];
		const a = lab[1];
		const b = lab[2];
		let x;
		let y;
		let z;

		y = (l + 16) / 116;
		x = a / 500 + y;
		z = y - b / 200;

		const y2 = y ** 3;
		const x2 = x ** 3;
		const z2 = z ** 3;
		y = y2 > 0.008856 ? y2 : (y - 16 / 116) / 7.787;
		x = x2 > 0.008856 ? x2 : (x - 16 / 116) / 7.787;
		z = z2 > 0.008856 ? z2 : (z - 16 / 116) / 7.787;

		x *= 95.047;
		y *= 100;
		z *= 108.883;

		return [x, y, z];
	};

	convert.lab.lch = function (lab) {
		const l = lab[0];
		const a = lab[1];
		const b = lab[2];
		let h;

		const hr = Math.atan2(b, a);
		h = hr * 360 / 2 / Math.PI;

		if (h < 0) {
			h += 360;
		}

		const c = Math.sqrt(a * a + b * b);

		return [l, c, h];
	};

	convert.lch.lab = function (lch) {
		const l = lch[0];
		const c = lch[1];
		const h = lch[2];

		const hr = h / 360 * 2 * Math.PI;
		const a = c * Math.cos(hr);
		const b = c * Math.sin(hr);

		return [l, a, b];
	};

	convert.rgb.ansi16 = function (args, saturation = null) {
		const [r, g, b] = args;
		let value = saturation === null ? convert.rgb.hsv(args)[2] : saturation; // Hsv -> ansi16 optimization

		value = Math.round(value / 50);

		if (value === 0) {
			return 30;
		}

		let ansi = 30
			+ ((Math.round(b / 255) << 2)
			| (Math.round(g / 255) << 1)
			| Math.round(r / 255));

		if (value === 2) {
			ansi += 60;
		}

		return ansi;
	};

	convert.hsv.ansi16 = function (args) {
		// Optimization here; we already know the value and don't need to get
		// it converted for us.
		return convert.rgb.ansi16(convert.hsv.rgb(args), args[2]);
	};

	convert.rgb.ansi256 = function (args) {
		const r = args[0];
		const g = args[1];
		const b = args[2];

		// We use the extended greyscale palette here, with the exception of
		// black and white. normal palette only has 4 greyscale shades.
		if (r === g && g === b) {
			if (r < 8) {
				return 16;
			}

			if (r > 248) {
				return 231;
			}

			return Math.round(((r - 8) / 247) * 24) + 232;
		}

		const ansi = 16
			+ (36 * Math.round(r / 255 * 5))
			+ (6 * Math.round(g / 255 * 5))
			+ Math.round(b / 255 * 5);

		return ansi;
	};

	convert.ansi16.rgb = function (args) {
		let color = args % 10;

		// Handle greyscale
		if (color === 0 || color === 7) {
			if (args > 50) {
				color += 3.5;
			}

			color = color / 10.5 * 255;

			return [color, color, color];
		}

		const mult = (~~(args > 50) + 1) * 0.5;
		const r = ((color & 1) * mult) * 255;
		const g = (((color >> 1) & 1) * mult) * 255;
		const b = (((color >> 2) & 1) * mult) * 255;

		return [r, g, b];
	};

	convert.ansi256.rgb = function (args) {
		// Handle greyscale
		if (args >= 232) {
			const c = (args - 232) * 10 + 8;
			return [c, c, c];
		}

		args -= 16;

		let rem;
		const r = Math.floor(args / 36) / 5 * 255;
		const g = Math.floor((rem = args % 36) / 6) / 5 * 255;
		const b = (rem % 6) / 5 * 255;

		return [r, g, b];
	};

	convert.rgb.hex = function (args) {
		const integer = ((Math.round(args[0]) & 0xFF) << 16)
			+ ((Math.round(args[1]) & 0xFF) << 8)
			+ (Math.round(args[2]) & 0xFF);

		const string = integer.toString(16).toUpperCase();
		return '000000'.substring(string.length) + string;
	};

	convert.hex.rgb = function (args) {
		const match = args.toString(16).match(/[a-f0-9]{6}|[a-f0-9]{3}/i);
		if (!match) {
			return [0, 0, 0];
		}

		let colorString = match[0];

		if (match[0].length === 3) {
			colorString = colorString.split('').map(char => {
				return char + char;
			}).join('');
		}

		const integer = parseInt(colorString, 16);
		const r = (integer >> 16) & 0xFF;
		const g = (integer >> 8) & 0xFF;
		const b = integer & 0xFF;

		return [r, g, b];
	};

	convert.rgb.hcg = function (rgb) {
		const r = rgb[0] / 255;
		const g = rgb[1] / 255;
		const b = rgb[2] / 255;
		const max = Math.max(Math.max(r, g), b);
		const min = Math.min(Math.min(r, g), b);
		const chroma = (max - min);
		let grayscale;
		let hue;

		if (chroma < 1) {
			grayscale = min / (1 - chroma);
		} else {
			grayscale = 0;
		}

		if (chroma <= 0) {
			hue = 0;
		} else
		if (max === r) {
			hue = ((g - b) / chroma) % 6;
		} else
		if (max === g) {
			hue = 2 + (b - r) / chroma;
		} else {
			hue = 4 + (r - g) / chroma;
		}

		hue /= 6;
		hue %= 1;

		return [hue * 360, chroma * 100, grayscale * 100];
	};

	convert.hsl.hcg = function (hsl) {
		const s = hsl[1] / 100;
		const l = hsl[2] / 100;

		const c = l < 0.5 ? (2.0 * s * l) : (2.0 * s * (1.0 - l));

		let f = 0;
		if (c < 1.0) {
			f = (l - 0.5 * c) / (1.0 - c);
		}

		return [hsl[0], c * 100, f * 100];
	};

	convert.hsv.hcg = function (hsv) {
		const s = hsv[1] / 100;
		const v = hsv[2] / 100;

		const c = s * v;
		let f = 0;

		if (c < 1.0) {
			f = (v - c) / (1 - c);
		}

		return [hsv[0], c * 100, f * 100];
	};

	convert.hcg.rgb = function (hcg) {
		const h = hcg[0] / 360;
		const c = hcg[1] / 100;
		const g = hcg[2] / 100;

		if (c === 0.0) {
			return [g * 255, g * 255, g * 255];
		}

		const pure = [0, 0, 0];
		const hi = (h % 1) * 6;
		const v = hi % 1;
		const w = 1 - v;
		let mg = 0;

		/* eslint-disable max-statements-per-line */
		switch (Math.floor(hi)) {
			case 0:
				pure[0] = 1; pure[1] = v; pure[2] = 0; break;
			case 1:
				pure[0] = w; pure[1] = 1; pure[2] = 0; break;
			case 2:
				pure[0] = 0; pure[1] = 1; pure[2] = v; break;
			case 3:
				pure[0] = 0; pure[1] = w; pure[2] = 1; break;
			case 4:
				pure[0] = v; pure[1] = 0; pure[2] = 1; break;
			default:
				pure[0] = 1; pure[1] = 0; pure[2] = w;
		}
		/* eslint-enable max-statements-per-line */

		mg = (1.0 - c) * g;

		return [
			(c * pure[0] + mg) * 255,
			(c * pure[1] + mg) * 255,
			(c * pure[2] + mg) * 255
		];
	};

	convert.hcg.hsv = function (hcg) {
		const c = hcg[1] / 100;
		const g = hcg[2] / 100;

		const v = c + g * (1.0 - c);
		let f = 0;

		if (v > 0.0) {
			f = c / v;
		}

		return [hcg[0], f * 100, v * 100];
	};

	convert.hcg.hsl = function (hcg) {
		const c = hcg[1] / 100;
		const g = hcg[2] / 100;

		const l = g * (1.0 - c) + 0.5 * c;
		let s = 0;

		if (l > 0.0 && l < 0.5) {
			s = c / (2 * l);
		} else
		if (l >= 0.5 && l < 1.0) {
			s = c / (2 * (1 - l));
		}

		return [hcg[0], s * 100, l * 100];
	};

	convert.hcg.hwb = function (hcg) {
		const c = hcg[1] / 100;
		const g = hcg[2] / 100;
		const v = c + g * (1.0 - c);
		return [hcg[0], (v - c) * 100, (1 - v) * 100];
	};

	convert.hwb.hcg = function (hwb) {
		const w = hwb[1] / 100;
		const b = hwb[2] / 100;
		const v = 1 - b;
		const c = v - w;
		let g = 0;

		if (c < 1) {
			g = (v - c) / (1 - c);
		}

		return [hwb[0], c * 100, g * 100];
	};

	convert.apple.rgb = function (apple) {
		return [(apple[0] / 65535) * 255, (apple[1] / 65535) * 255, (apple[2] / 65535) * 255];
	};

	convert.rgb.apple = function (rgb) {
		return [(rgb[0] / 255) * 65535, (rgb[1] / 255) * 65535, (rgb[2] / 255) * 65535];
	};

	convert.gray.rgb = function (args) {
		return [args[0] / 100 * 255, args[0] / 100 * 255, args[0] / 100 * 255];
	};

	convert.gray.hsl = function (args) {
		return [0, 0, args[0]];
	};

	convert.gray.hsv = convert.gray.hsl;

	convert.gray.hwb = function (gray) {
		return [0, 100, gray[0]];
	};

	convert.gray.cmyk = function (gray) {
		return [0, 0, 0, gray[0]];
	};

	convert.gray.lab = function (gray) {
		return [gray[0], 0, 0];
	};

	convert.gray.hex = function (gray) {
		const val = Math.round(gray[0] / 100 * 255) & 0xFF;
		const integer = (val << 16) + (val << 8) + val;

		const string = integer.toString(16).toUpperCase();
		return '000000'.substring(string.length) + string;
	};

	convert.rgb.gray = function (rgb) {
		const val = (rgb[0] + rgb[1] + rgb[2]) / 3;
		return [val / 255 * 100];
	};
	return conversions;
}

var route;
var hasRequiredRoute;

function requireRoute () {
	if (hasRequiredRoute) return route;
	hasRequiredRoute = 1;
	const conversions = requireConversions();

	/*
		This function routes a model to all other models.

		all functions that are routed have a property `.conversion` attached
		to the returned synthetic function. This property is an array
		of strings, each with the steps in between the 'from' and 'to'
		color models (inclusive).

		conversions that are not possible simply are not included.
	*/

	function buildGraph() {
		const graph = {};
		// https://jsperf.com/object-keys-vs-for-in-with-closure/3
		const models = Object.keys(conversions);

		for (let len = models.length, i = 0; i < len; i++) {
			graph[models[i]] = {
				// http://jsperf.com/1-vs-infinity
				// micro-opt, but this is simple.
				distance: -1,
				parent: null
			};
		}

		return graph;
	}

	// https://en.wikipedia.org/wiki/Breadth-first_search
	function deriveBFS(fromModel) {
		const graph = buildGraph();
		const queue = [fromModel]; // Unshift -> queue -> pop

		graph[fromModel].distance = 0;

		while (queue.length) {
			const current = queue.pop();
			const adjacents = Object.keys(conversions[current]);

			for (let len = adjacents.length, i = 0; i < len; i++) {
				const adjacent = adjacents[i];
				const node = graph[adjacent];

				if (node.distance === -1) {
					node.distance = graph[current].distance + 1;
					node.parent = current;
					queue.unshift(adjacent);
				}
			}
		}

		return graph;
	}

	function link(from, to) {
		return function (args) {
			return to(from(args));
		};
	}

	function wrapConversion(toModel, graph) {
		const path = [graph[toModel].parent, toModel];
		let fn = conversions[graph[toModel].parent][toModel];

		let cur = graph[toModel].parent;
		while (graph[cur].parent) {
			path.unshift(graph[cur].parent);
			fn = link(conversions[graph[cur].parent][cur], fn);
			cur = graph[cur].parent;
		}

		fn.conversion = path;
		return fn;
	}

	route = function (fromModel) {
		const graph = deriveBFS(fromModel);
		const conversion = {};

		const models = Object.keys(graph);
		for (let len = models.length, i = 0; i < len; i++) {
			const toModel = models[i];
			const node = graph[toModel];

			if (node.parent === null) {
				// No possible conversion, or this node is the source model.
				continue;
			}

			conversion[toModel] = wrapConversion(toModel, graph);
		}

		return conversion;
	};
	return route;
}

var colorConvert;
var hasRequiredColorConvert;

function requireColorConvert () {
	if (hasRequiredColorConvert) return colorConvert;
	hasRequiredColorConvert = 1;
	const conversions = requireConversions();
	const route = requireRoute();

	const convert = {};

	const models = Object.keys(conversions);

	function wrapRaw(fn) {
		const wrappedFn = function (...args) {
			const arg0 = args[0];
			if (arg0 === undefined || arg0 === null) {
				return arg0;
			}

			if (arg0.length > 1) {
				args = arg0;
			}

			return fn(args);
		};

		// Preserve .conversion property if there is one
		if ('conversion' in fn) {
			wrappedFn.conversion = fn.conversion;
		}

		return wrappedFn;
	}

	function wrapRounded(fn) {
		const wrappedFn = function (...args) {
			const arg0 = args[0];

			if (arg0 === undefined || arg0 === null) {
				return arg0;
			}

			if (arg0.length > 1) {
				args = arg0;
			}

			const result = fn(args);

			// We're assuming the result is an array here.
			// see notice in conversions.js; don't use box types
			// in conversion functions.
			if (typeof result === 'object') {
				for (let len = result.length, i = 0; i < len; i++) {
					result[i] = Math.round(result[i]);
				}
			}

			return result;
		};

		// Preserve .conversion property if there is one
		if ('conversion' in fn) {
			wrappedFn.conversion = fn.conversion;
		}

		return wrappedFn;
	}

	models.forEach(fromModel => {
		convert[fromModel] = {};

		Object.defineProperty(convert[fromModel], 'channels', {value: conversions[fromModel].channels});
		Object.defineProperty(convert[fromModel], 'labels', {value: conversions[fromModel].labels});

		const routes = route(fromModel);
		const routeModels = Object.keys(routes);

		routeModels.forEach(toModel => {
			const fn = routes[toModel];

			convert[fromModel][toModel] = wrapRounded(fn);
			convert[fromModel][toModel].raw = wrapRaw(fn);
		});
	});

	colorConvert = convert;
	return colorConvert;
}

ansiStyles.exports;

var hasRequiredAnsiStyles;

function requireAnsiStyles () {
	if (hasRequiredAnsiStyles) return ansiStyles.exports;
	hasRequiredAnsiStyles = 1;
	(function (module) {

		const wrapAnsi16 = (fn, offset) => (...args) => {
			const code = fn(...args);
			return `\u001B[${code + offset}m`;
		};

		const wrapAnsi256 = (fn, offset) => (...args) => {
			const code = fn(...args);
			return `\u001B[${38 + offset};5;${code}m`;
		};

		const wrapAnsi16m = (fn, offset) => (...args) => {
			const rgb = fn(...args);
			return `\u001B[${38 + offset};2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
		};

		const ansi2ansi = n => n;
		const rgb2rgb = (r, g, b) => [r, g, b];

		const setLazyProperty = (object, property, get) => {
			Object.defineProperty(object, property, {
				get: () => {
					const value = get();

					Object.defineProperty(object, property, {
						value,
						enumerable: true,
						configurable: true
					});

					return value;
				},
				enumerable: true,
				configurable: true
			});
		};

		/** @type {typeof import('color-convert')} */
		let colorConvert;
		const makeDynamicStyles = (wrap, targetSpace, identity, isBackground) => {
			if (colorConvert === undefined) {
				colorConvert = requireColorConvert();
			}

			const offset = isBackground ? 10 : 0;
			const styles = {};

			for (const [sourceSpace, suite] of Object.entries(colorConvert)) {
				const name = sourceSpace === 'ansi16' ? 'ansi' : sourceSpace;
				if (sourceSpace === targetSpace) {
					styles[name] = wrap(identity, offset);
				} else if (typeof suite === 'object') {
					styles[name] = wrap(suite[targetSpace], offset);
				}
			}

			return styles;
		};

		function assembleStyles() {
			const codes = new Map();
			const styles = {
				modifier: {
					reset: [0, 0],
					// 21 isn't widely supported and 22 does the same thing
					bold: [1, 22],
					dim: [2, 22],
					italic: [3, 23],
					underline: [4, 24],
					inverse: [7, 27],
					hidden: [8, 28],
					strikethrough: [9, 29]
				},
				color: {
					black: [30, 39],
					red: [31, 39],
					green: [32, 39],
					yellow: [33, 39],
					blue: [34, 39],
					magenta: [35, 39],
					cyan: [36, 39],
					white: [37, 39],

					// Bright color
					blackBright: [90, 39],
					redBright: [91, 39],
					greenBright: [92, 39],
					yellowBright: [93, 39],
					blueBright: [94, 39],
					magentaBright: [95, 39],
					cyanBright: [96, 39],
					whiteBright: [97, 39]
				},
				bgColor: {
					bgBlack: [40, 49],
					bgRed: [41, 49],
					bgGreen: [42, 49],
					bgYellow: [43, 49],
					bgBlue: [44, 49],
					bgMagenta: [45, 49],
					bgCyan: [46, 49],
					bgWhite: [47, 49],

					// Bright color
					bgBlackBright: [100, 49],
					bgRedBright: [101, 49],
					bgGreenBright: [102, 49],
					bgYellowBright: [103, 49],
					bgBlueBright: [104, 49],
					bgMagentaBright: [105, 49],
					bgCyanBright: [106, 49],
					bgWhiteBright: [107, 49]
				}
			};

			// Alias bright black as gray (and grey)
			styles.color.gray = styles.color.blackBright;
			styles.bgColor.bgGray = styles.bgColor.bgBlackBright;
			styles.color.grey = styles.color.blackBright;
			styles.bgColor.bgGrey = styles.bgColor.bgBlackBright;

			for (const [groupName, group] of Object.entries(styles)) {
				for (const [styleName, style] of Object.entries(group)) {
					styles[styleName] = {
						open: `\u001B[${style[0]}m`,
						close: `\u001B[${style[1]}m`
					};

					group[styleName] = styles[styleName];

					codes.set(style[0], style[1]);
				}

				Object.defineProperty(styles, groupName, {
					value: group,
					enumerable: false
				});
			}

			Object.defineProperty(styles, 'codes', {
				value: codes,
				enumerable: false
			});

			styles.color.close = '\u001B[39m';
			styles.bgColor.close = '\u001B[49m';

			setLazyProperty(styles.color, 'ansi', () => makeDynamicStyles(wrapAnsi16, 'ansi16', ansi2ansi, false));
			setLazyProperty(styles.color, 'ansi256', () => makeDynamicStyles(wrapAnsi256, 'ansi256', ansi2ansi, false));
			setLazyProperty(styles.color, 'ansi16m', () => makeDynamicStyles(wrapAnsi16m, 'rgb', rgb2rgb, false));
			setLazyProperty(styles.bgColor, 'ansi', () => makeDynamicStyles(wrapAnsi16, 'ansi16', ansi2ansi, true));
			setLazyProperty(styles.bgColor, 'ansi256', () => makeDynamicStyles(wrapAnsi256, 'ansi256', ansi2ansi, true));
			setLazyProperty(styles.bgColor, 'ansi16m', () => makeDynamicStyles(wrapAnsi16m, 'rgb', rgb2rgb, true));

			return styles;
		}

		// Make the export immutable
		Object.defineProperty(module, 'exports', {
			enumerable: true,
			get: assembleStyles
		}); 
	} (ansiStyles));
	return ansiStyles.exports;
}

var wrapAnsi_1;
var hasRequiredWrapAnsi;

function requireWrapAnsi () {
	if (hasRequiredWrapAnsi) return wrapAnsi_1;
	hasRequiredWrapAnsi = 1;
	const stringWidth = requireStringWidth();
	const stripAnsi = requireStripAnsi();
	const ansiStyles = requireAnsiStyles();

	const ESCAPES = new Set([
		'\u001B',
		'\u009B'
	]);

	const END_CODE = 39;

	const ANSI_ESCAPE_BELL = '\u0007';
	const ANSI_CSI = '[';
	const ANSI_OSC = ']';
	const ANSI_SGR_TERMINATOR = 'm';
	const ANSI_ESCAPE_LINK = `${ANSI_OSC}8;;`;

	const wrapAnsi = code => `${ESCAPES.values().next().value}${ANSI_CSI}${code}${ANSI_SGR_TERMINATOR}`;
	const wrapAnsiHyperlink = uri => `${ESCAPES.values().next().value}${ANSI_ESCAPE_LINK}${uri}${ANSI_ESCAPE_BELL}`;

	// Calculate the length of words split on ' ', ignoring
	// the extra characters added by ansi escape codes
	const wordLengths = string => string.split(' ').map(character => stringWidth(character));

	// Wrap a long word across multiple rows
	// Ansi escape codes do not count towards length
	const wrapWord = (rows, word, columns) => {
		const characters = [...word];

		let isInsideEscape = false;
		let isInsideLinkEscape = false;
		let visible = stringWidth(stripAnsi(rows[rows.length - 1]));

		for (const [index, character] of characters.entries()) {
			const characterLength = stringWidth(character);

			if (visible + characterLength <= columns) {
				rows[rows.length - 1] += character;
			} else {
				rows.push(character);
				visible = 0;
			}

			if (ESCAPES.has(character)) {
				isInsideEscape = true;
				isInsideLinkEscape = characters.slice(index + 1).join('').startsWith(ANSI_ESCAPE_LINK);
			}

			if (isInsideEscape) {
				if (isInsideLinkEscape) {
					if (character === ANSI_ESCAPE_BELL) {
						isInsideEscape = false;
						isInsideLinkEscape = false;
					}
				} else if (character === ANSI_SGR_TERMINATOR) {
					isInsideEscape = false;
				}

				continue;
			}

			visible += characterLength;

			if (visible === columns && index < characters.length - 1) {
				rows.push('');
				visible = 0;
			}
		}

		// It's possible that the last row we copy over is only
		// ansi escape characters, handle this edge-case
		if (!visible && rows[rows.length - 1].length > 0 && rows.length > 1) {
			rows[rows.length - 2] += rows.pop();
		}
	};

	// Trims spaces from a string ignoring invisible sequences
	const stringVisibleTrimSpacesRight = string => {
		const words = string.split(' ');
		let last = words.length;

		while (last > 0) {
			if (stringWidth(words[last - 1]) > 0) {
				break;
			}

			last--;
		}

		if (last === words.length) {
			return string;
		}

		return words.slice(0, last).join(' ') + words.slice(last).join('');
	};

	// The wrap-ansi module can be invoked in either 'hard' or 'soft' wrap mode
	//
	// 'hard' will never allow a string to take up more than columns characters
	//
	// 'soft' allows long words to expand past the column length
	const exec = (string, columns, options = {}) => {
		if (options.trim !== false && string.trim() === '') {
			return '';
		}

		let returnValue = '';
		let escapeCode;
		let escapeUrl;

		const lengths = wordLengths(string);
		let rows = [''];

		for (const [index, word] of string.split(' ').entries()) {
			if (options.trim !== false) {
				rows[rows.length - 1] = rows[rows.length - 1].trimStart();
			}

			let rowLength = stringWidth(rows[rows.length - 1]);

			if (index !== 0) {
				if (rowLength >= columns && (options.wordWrap === false || options.trim === false)) {
					// If we start with a new word but the current row length equals the length of the columns, add a new row
					rows.push('');
					rowLength = 0;
				}

				if (rowLength > 0 || options.trim === false) {
					rows[rows.length - 1] += ' ';
					rowLength++;
				}
			}

			// In 'hard' wrap mode, the length of a line is never allowed to extend past 'columns'
			if (options.hard && lengths[index] > columns) {
				const remainingColumns = (columns - rowLength);
				const breaksStartingThisLine = 1 + Math.floor((lengths[index] - remainingColumns - 1) / columns);
				const breaksStartingNextLine = Math.floor((lengths[index] - 1) / columns);
				if (breaksStartingNextLine < breaksStartingThisLine) {
					rows.push('');
				}

				wrapWord(rows, word, columns);
				continue;
			}

			if (rowLength + lengths[index] > columns && rowLength > 0 && lengths[index] > 0) {
				if (options.wordWrap === false && rowLength < columns) {
					wrapWord(rows, word, columns);
					continue;
				}

				rows.push('');
			}

			if (rowLength + lengths[index] > columns && options.wordWrap === false) {
				wrapWord(rows, word, columns);
				continue;
			}

			rows[rows.length - 1] += word;
		}

		if (options.trim !== false) {
			rows = rows.map(stringVisibleTrimSpacesRight);
		}

		const pre = [...rows.join('\n')];

		for (const [index, character] of pre.entries()) {
			returnValue += character;

			if (ESCAPES.has(character)) {
				const {groups} = new RegExp(`(?:\\${ANSI_CSI}(?<code>\\d+)m|\\${ANSI_ESCAPE_LINK}(?<uri>.*)${ANSI_ESCAPE_BELL})`).exec(pre.slice(index).join('')) || {groups: {}};
				if (groups.code !== undefined) {
					const code = Number.parseFloat(groups.code);
					escapeCode = code === END_CODE ? undefined : code;
				} else if (groups.uri !== undefined) {
					escapeUrl = groups.uri.length === 0 ? undefined : groups.uri;
				}
			}

			const code = ansiStyles.codes.get(Number(escapeCode));

			if (pre[index + 1] === '\n') {
				if (escapeUrl) {
					returnValue += wrapAnsiHyperlink('');
				}

				if (escapeCode && code) {
					returnValue += wrapAnsi(code);
				}
			} else if (character === '\n') {
				if (escapeCode && code) {
					returnValue += wrapAnsi(escapeCode);
				}

				if (escapeUrl) {
					returnValue += wrapAnsiHyperlink(escapeUrl);
				}
			}
		}

		return returnValue;
	};

	// For each newline, invoke the method separately
	wrapAnsi_1 = (string, columns, options) => {
		return String(string)
			.normalize()
			.replace(/\r\n/g, '\n')
			.split('\n')
			.map(line => exec(line, columns, options))
			.join('\n');
	};
	return wrapAnsi_1;
}

var hasRequiredBoxen;

function requireBoxen () {
	if (hasRequiredBoxen) return boxen$1.exports;
	hasRequiredBoxen = 1;
	const stringWidth = requireStringWidth();
	const chalk$1 = chalk;
	const widestLine = requireWidestLine();
	const cliBoxes = requireCliBoxes();
	const camelCase = requireCamelcase();
	const ansiAlign = requireAnsiAlign();
	const wrapAnsi = requireWrapAnsi();

	const NL = '\n';
	const PAD = ' ';

	const terminalColumns = () => {
		const {env, stdout, stderr} = process;

		if (stdout && stdout.columns) {
			return stdout.columns;
		}

		if (stderr && stderr.columns) {
			return stderr.columns;
		}

		if (env.COLUMNS) {
			return Number.parseInt(env.COLUMNS, 10);
		}

		return 80;
	};

	const getObject = detail => {
		return typeof detail === 'number' ? {
			top: detail,
			right: detail * 3,
			bottom: detail,
			left: detail * 3
		} : {
			top: 0,
			right: 0,
			bottom: 0,
			left: 0,
			...detail
		};
	};

	const getBorderChars = borderStyle => {
		const sides = [
			'topLeft',
			'topRight',
			'bottomRight',
			'bottomLeft',
			'vertical',
			'horizontal'
		];

		let chararacters;

		if (typeof borderStyle === 'string') {
			chararacters = cliBoxes[borderStyle];

			if (!chararacters) {
				throw new TypeError(`Invalid border style: ${borderStyle}`);
			}
		} else {
			for (const side of sides) {
				if (!borderStyle[side] || typeof borderStyle[side] !== 'string') {
					throw new TypeError(`Invalid border style: ${side}`);
				}
			}

			chararacters = borderStyle;
		}

		return chararacters;
	};

	const makeTitle = (text, horizontal, alignement) => {
		let title = '';

		const textWidth = stringWidth(text);

		switch (alignement) {
			case 'left':
				title = text + horizontal.slice(textWidth);
				break;
			case 'right':
				title = horizontal.slice(textWidth) + text;
				break;
			default:
				horizontal = horizontal.slice(textWidth);

				if (horizontal.length % 2 === 1) { // This is needed in case the length is odd
					horizontal = horizontal.slice(Math.floor(horizontal.length / 2));
					title = horizontal.slice(1) + text + horizontal; // We reduce the left part of one character to avoid the bar to go beyond its limit
				} else {
					horizontal = horizontal.slice(horizontal.length / 2);
					title = horizontal + text + horizontal;
				}

				break;
		}

		return title;
	};

	const makeContentText = (text, padding, columns, align) => {
		text = ansiAlign(text, {align});
		let lines = text.split(NL);
		const textWidth = widestLine(text);

		const max = columns - padding.left - padding.right;

		if (textWidth > max) {
			const newLines = [];
			for (const line of lines) {
				const createdLines = wrapAnsi(line, max, {hard: true});
				const alignedLines = ansiAlign(createdLines, {align});
				const alignedLinesArray = alignedLines.split('\n');
				const longestLength = Math.max(...alignedLinesArray.map(s => stringWidth(s)));

				for (const alignedLine of alignedLinesArray) {
					let paddedLine;
					switch (align) {
						case 'center':
							paddedLine = PAD.repeat((max - longestLength) / 2) + alignedLine;
							break;
						case 'right':
							paddedLine = PAD.repeat(max - longestLength) + alignedLine;
							break;
						default:
							paddedLine = alignedLine;
							break;
					}

					newLines.push(paddedLine);
				}
			}

			lines = newLines;
		}

		if (align === 'center' && textWidth < max) {
			lines = lines.map(line => PAD.repeat((max - textWidth) / 2) + line);
		} else if (align === 'right' && textWidth < max) {
			lines = lines.map(line => PAD.repeat(max - textWidth) + line);
		}

		const paddingLeft = PAD.repeat(padding.left);
		const paddingRight = PAD.repeat(padding.right);

		lines = lines.map(line => paddingLeft + line + paddingRight);

		lines = lines.map(line => {
			if (columns - stringWidth(line) > 0) {
				switch (align) {
					case 'center':
						return line + PAD.repeat(columns - stringWidth(line));
					case 'right':
						return line + PAD.repeat(columns - stringWidth(line));
					default:
						return line + PAD.repeat(columns - stringWidth(line));
				}
			}

			return line;
		});

		if (padding.top > 0) {
			lines = new Array(padding.top).fill(PAD.repeat(columns)).concat(lines);
		}

		if (padding.bottom > 0) {
			lines = lines.concat(new Array(padding.bottom).fill(PAD.repeat(columns)));
		}

		return lines.join(NL);
	};

	const isHex = color => color.match(/^#(?:[0-f]{3}){1,2}$/i);
	const isColorValid = color => typeof color === 'string' && ((chalk$1[color]) || isHex(color));
	const getColorFn = color => isHex(color) ? chalk$1.hex(color) : chalk$1[color];
	const getBGColorFn = color => isHex(color) ? chalk$1.bgHex(color) : chalk$1[camelCase(['bg', color])];

	boxen$1.exports = (text, options) => {
		options = {
			padding: 0,
			borderStyle: 'single',
			dimBorder: false,
			textAlignment: 'left',
			float: 'left',
			titleAlignment: 'left',
			...options
		};

		// This option is deprecated
		if (options.align) {
			options.textAlignment = options.align;
		}

		const BORDERS_WIDTH = 2;

		if (options.borderColor && !isColorValid(options.borderColor)) {
			throw new Error(`${options.borderColor} is not a valid borderColor`);
		}

		if (options.backgroundColor && !isColorValid(options.backgroundColor)) {
			throw new Error(`${options.backgroundColor} is not a valid backgroundColor`);
		}

		const chars = getBorderChars(options.borderStyle);
		const padding = getObject(options.padding);
		const margin = getObject(options.margin);

		const colorizeBorder = border => {
			const newBorder = options.borderColor ? getColorFn(options.borderColor)(border) : border;
			return options.dimBorder ? chalk$1.dim(newBorder) : newBorder;
		};

		const colorizeContent = content => options.backgroundColor ? getBGColorFn(options.backgroundColor)(content) : content;

		const columns = terminalColumns() - 1;

		let contentWidth = widestLine(wrapAnsi(text, columns - BORDERS_WIDTH, {hard: true, trim: false})) + padding.left + padding.right;

		// This prevents the title bar to exceed the console's width
		let title = options.title && options.title.slice(0, columns - 4 - margin.left - margin.right);

		if (title) {
			title = ` ${title} `;
			// Make the box larger to fit a larger title
			if (stringWidth(title) > contentWidth) {
				contentWidth = stringWidth(title);
			}
		}

		if ((margin.left && margin.right) && contentWidth + BORDERS_WIDTH + margin.left + margin.right > columns) {
			// Let's assume we have margins: left = 3, right = 5, in total = 8
			const spaceForMargins = columns - contentWidth - BORDERS_WIDTH;
			// Let's assume we have space = 4
			const multiplier = spaceForMargins / (margin.left + margin.right);
			// Here: multiplier = 4/8 = 0.5
			margin.left = Math.max(0, Math.floor(margin.left * multiplier));
			margin.right = Math.max(0, Math.floor(margin.right * multiplier));
			// Left: 3 * 0.5 = 1.5 -> 1
			// Right: 6 * 0.5 = 3
		}

		// Prevent content from exceeding the console's width
		contentWidth = Math.min(contentWidth, columns - BORDERS_WIDTH - margin.left - margin.right);

		text = makeContentText(text, padding, contentWidth, options.textAlignment);

		let marginLeft = PAD.repeat(margin.left);

		if (options.float === 'center') {
			const marginWidth = Math.max((columns - contentWidth - BORDERS_WIDTH) / 2, 0);
			marginLeft = PAD.repeat(marginWidth);
		} else if (options.float === 'right') {
			const marginWidth = Math.max(columns - contentWidth - margin.right - BORDERS_WIDTH, 0);
			marginLeft = PAD.repeat(marginWidth);
		}

		const horizontal = chars.horizontal.repeat(contentWidth);
		const top = colorizeBorder(NL.repeat(margin.top) + marginLeft + chars.topLeft + (title ? makeTitle(title, horizontal, options.titleAlignment) : horizontal) + chars.topRight);
		const bottom = colorizeBorder(marginLeft + chars.bottomLeft + horizontal + chars.bottomRight + NL.repeat(margin.bottom));
		const side = colorizeBorder(chars.vertical);

		const LINE_SEPARATOR = NL;

		const lines = text.split(NL);

		const middle = lines.map(line => {
			return marginLeft + side + colorizeContent(line) + side;
		}).join(LINE_SEPARATOR);

		return top + LINE_SEPARATOR + middle + LINE_SEPARATOR + bottom;
	};

	boxen$1.exports._borderStyles = cliBoxes;
	return boxen$1.exports;
}

var boxenExports = requireBoxen();
var boxen = /*@__PURE__*/getDefaultExportFromCjs(boxenExports);

function makeTitledPrettyError(title, content, stack) {
    return makePrettyError(chalk.redBright(title) + "\n\n" + content, stack);
}
function makePrettyError(content, stack) {
    if (process$1.browser || process$1.env.LMS_NO_FANCY_ERRORS || lmsIsomorphic.terminalSize().columns < 80) {
        const error = new Error(content);
        if (stack === undefined) {
            changeErrorStackInPlace(error, "");
        }
        else {
            changeErrorStackInPlace(error, stack);
        }
        return error;
    }
    else {
        if (stack !== undefined) {
            content +=
                "\n\n\n " + chalk.bgWhite.black("  </> STACK TRACE  ") + "\n\n" + chalk.gray(stack);
        }
        const error = new Error("\n" + boxen(content, { padding: 1, margin: 1, borderColor: "redBright", title: "Error" }));
        Object.defineProperty(error, "lmstudioRawError", { value: content, enumerable: false });
        changeErrorStackInPlace(error, "");
        return error;
    }
}

/**
 * A cache for avoiding recompiling the same template strings.
 *
 * The cached value is a string with 2N + 1 elements, where N is the number of variables in the
 * template.
 */
const compiledTemplatesCache = new WeakMap();
/**
 * A string literal tag function that does the following:
 *
 * - Removes leading new lines
 * - Removes trailing new lines and whitespace
 * - Removes common indentation from the start of each line (Empty lines are ignored)
 * - Single newlines are replaced with a space + extra whitespace is removed
 *
 * Note: Only spaces are considered.
 *
 * @remarks
 *
 * The exact implementation of this function is not guaranteed to be the same, as we may add
 * additional edge case handling in the future. However, the general behavior should remain the
 * same.
 *
 * @public
 */
function text(strings, ...values) {
    if (values.length + 1 !== strings.length) {
        throw new Error("text called with the wrong number of arguments.");
    }
    let compiled = compiledTemplatesCache.get(strings);
    if (compiled === undefined) {
        compiled = compile(strings);
        compiledTemplatesCache.set(strings, compiled);
    }
    // We can modify the array in place because JavaScript is single-threaded and the array is not
    // being accessed by any other code.
    for (let i = 0; i < values.length; i++) {
        if (typeof values[i] === "object") {
            if (typeof values[i].stack === "string") {
                compiled[i * 2 + 1] = values[i].stack;
            }
            else {
                try {
                    compiled[i * 2 + 1] = JSON.stringify(values[i]);
                }
                catch (error) {
                    compiled[i * 2 + 1] = "[Object failed to stringify]";
                }
            }
        }
        else {
            compiled[i * 2 + 1] = String(values[i]);
        }
    }
    return compiled.join("");
}
function removeLeadingNewlines(input) {
    return input.replace(/^\n+/, "");
}
function removeTrailingNewlinesAndWhitespace(input) {
    return input.replace(/[\n ]+$/, "");
}
function removeLeadingWhitespace(input) {
    return input.replace(/^ +/, "");
}
function removeTrailingWhitespace(input) {
    return input.replace(/ +$/, "");
}
function breakIntoLines(strings) {
    const lines = [];
    let currentLine = [];
    for (const string of strings) {
        let prevNewlineIndex = -1;
        let nextNewlineIndex;
        while ((nextNewlineIndex = string.indexOf("\n", prevNewlineIndex + 1)) !== -1) {
            currentLine.push(string.substring(prevNewlineIndex + 1, nextNewlineIndex));
            lines.push(currentLine);
            currentLine = [];
            prevNewlineIndex = nextNewlineIndex;
        }
        currentLine.push(string.substring(prevNewlineIndex + 1));
    }
    lines.push(currentLine);
    return lines;
}
/**
 * Returns the number of spaces at the start of the string. If the string only contains spaces,
 * returns infinity.
 */
function countStringIndentations(string) {
    let count = 0;
    for (const char of string) {
        if (char === " ") {
            count++;
        }
        else {
            return count;
        }
    }
    return Infinity;
}
function countLineIndentations(line) {
    const firstPart = line[0];
    const firstPartIndentation = countStringIndentations(firstPart);
    if (firstPartIndentation === Infinity) {
        if (line.length === 1) {
            return Infinity;
        }
        else {
            // If there is a variable after it, the length of indentation is the same as the length of the
            // first part.
            return firstPart.length;
        }
    }
    return firstPartIndentation;
}
function findMaxCommonIndentation(lines) {
    let minIndentation = Infinity;
    for (const line of lines) {
        minIndentation = Math.min(minIndentation, countLineIndentations(line));
    }
    return minIndentation;
}
function removeIndentation(line, indentation) {
    if (line.length < indentation) {
        return "";
    }
    return line.slice(indentation);
}
function removeAllIndentation(lines, indentation) {
    for (const line of lines) {
        line[0] = removeIndentation(line[0], indentation);
    }
}
function isEmptyLine(line) {
    if (line.length !== 1) {
        return false;
    }
    for (const char of line[0]) {
        if (char !== " ") {
            return false;
        }
    }
    return true;
}
function mergeLines(lines) {
    const linesAreEmpty = lines.map(isEmptyLine);
    const paragraphs = [];
    let currentParagraph = [];
    for (let i = 0; i < lines.length; i++) {
        if (linesAreEmpty[i]) {
            if (currentParagraph.length !== 0) {
                paragraphs.push(currentParagraph);
                currentParagraph = [];
            }
            continue;
        }
        if (currentParagraph.length !== 0) {
            const last = removeTrailingWhitespace(currentParagraph[currentParagraph.length - 1]);
            const next = removeLeadingWhitespace(lines[i][0]);
            currentParagraph[currentParagraph.length - 1] = last + " " + next;
            currentParagraph.push(...lines[i].slice(1));
        }
        else {
            currentParagraph.push(...lines[i]);
        }
    }
    if (currentParagraph.length !== 0) {
        paragraphs.push(currentParagraph);
    }
    return paragraphs;
}
function mergeParagraphs(paragraphs) {
    const result = [];
    if (paragraphs.length === 0) {
        return [""];
    }
    result.push(...paragraphs[0]);
    for (let i = 1; i < paragraphs.length; i++) {
        result[result.length - 1] += "\n\n" + paragraphs[i][0];
        result.push(...paragraphs[i].slice(1));
    }
    return result;
}
function addHolesForVariables(strings) {
    const result = [];
    for (let i = 0; i < strings.length; i++) {
        result.push(strings[i]);
        if (i < strings.length - 1) {
            result.push("");
        }
    }
    return result;
}
function compile(readonlyStrings) {
    const strings = [...readonlyStrings];
    strings[0] = removeLeadingNewlines(strings[0]);
    strings[strings.length - 1] = removeTrailingNewlinesAndWhitespace(strings[strings.length - 1]);
    const lines = breakIntoLines(strings);
    const commonIndentation = findMaxCommonIndentation(lines);
    removeAllIndentation(lines, commonIndentation);
    const paragraphs = mergeLines(lines);
    return addHolesForVariables(mergeParagraphs(paragraphs));
}

/**
 * Represents some underlying data that may or may not be mutable.
 *
 * @public
 */
class MaybeMutable {
    constructor(data, mutable) {
        this.data = data;
        this.mutable = mutable;
    }
    /**
     * Gets the underlying data without any access control. Only used internally.
     *
     * @internal
     */
    _internalGetData() {
        return this.data;
    }
    /**
     * If this instance is mutable, return as is.
     *
     * If this instance is immutable, return a mutable copy.
     *
     * Very easy to misuse, thus internal only for now.
     *
     * @internal
     */
    _internalToMutable() {
        if (this.mutable) {
            return this;
        }
        return this.asMutableCopy();
    }
    asMutableCopy() {
        return this.create(this.cloneData(this.data), true);
    }
    asImmutableCopy() {
        if (this.mutable) {
            return this.create(this.cloneData(this.data), false);
        }
        return this;
    }
    guardMutable() {
        if (!this.mutable) {
            throw new Error(text `
        Cannot modify immutable ${this.getClassName()} instance. Use asMutableCopy() to get a
        mutable copy.
      `);
        }
    }
}
function accessMaybeMutableInternals(maybeMutable) {
    return maybeMutable;
}

/**
 * OWLSignal - Optimistic Writable Lazy Signal
 *
 * - Signal: It is a signal, i.e. an observable that remembers its current value
 * - Lazy: It is lazy, i.e. it does not subscribe to the upstream until a subscriber is attached
 * - Writable: It is writable, i.e. it has a setter to update its value
 * - Optimistic: It is optimistic, i.e. it updates its value optimistically and then waits for the
 *   upstream to confirm the update
 *   - Once the setter is called, the value is updated optimistically and all subscribers are
 *     notified synchronously
 *
 * Guarantees:
 *
 * - The OWLSignal is designed for single-writer multiple-reader scenarios, as the coordination of
 *   writes are tracked inside the OWLSignal. If there are multiple writers for the same data (i.e.
 *   multiple OWLSignal backed by the same upstream), there are no strong guarantees. For example,
 *   two updaters may read the same value, update it, and write it back to the upstream, causing one
 *   of the updates to be lost. The following guarantees are provided for single-writer scenarios:
 * - The updates are applied in the order they are received, and each updater is guaranteed to see
 *   all updates that were applied before it.
 * - If there are updaters [u_0, u_1, ..., u_n], for any read-only reader, there exists a time t
 *   where the reader will see the updates [u_0, u_1, ..., u_t] in the order they were applied. This
 *   also applies to the writer itself.
 */
class OWLSignal extends Subscribable {
    static { this.NOT_AVAILABLE = LazySignal.NOT_AVAILABLE; }
    applyOptimisticUpdates(data) {
        for (const update of this.queuedUpdates) {
            [data] = update.updater(data);
        }
        return data;
    }
    updateOptimisticValue(tags) {
        const innerValue = this.innerSignal.get();
        if (!isAvailable(innerValue)) {
            return;
        }
        this.setOuterSignal(this.applyOptimisticUpdates(innerValue), tags);
    }
    constructor(initialValue, subscribeUpstream, writeUpstream, equalsPredicate) {
        super();
        this.writeUpstream = writeUpstream;
        this.isWriteLoopRunning = false;
        /**
         * We have a passive subscription to the inner signal to update the optimistic value whenever the
         * inner signal changes.
         *
         * However, if the content changes are caused by a write, we want to update the inner value,
         * remove the optimistic update, and apply the remaining optimistic updates all at once.
         *
         * Therefore, when a write is ongoing, we set this flag to true to prevent the passive
         * subscription from updating the optimistic value. We will handle the updates within the write
         * loop.
         */
        this.isSubscriptionHandledByWriteLoop = false;
        /**
         * A queue of updates to apply optimistically.
         */
        this.queuedUpdates = [];
        this.currentEnsureAvailablePromise = null;
        [this.writeErrorEvent, this.emitWriteErrorEvent] = Event.create();
        [this.outerSignal, this.setOuterSignal] = Signal.create(initialValue, equalsPredicate);
        this.innerSignal = LazySignal.create(initialValue, subscribeUpstream, equalsPredicate);
        this.innerSignal.passiveSubscribeFull((_data, _patches, tags) => {
            if (this.isSubscriptionHandledByWriteLoop) {
                return;
            }
            this.updateOptimisticValue(tags);
        });
    }
    static create(initialValue, subscribeUpstream, 
    /**
     * Returns true if the update is sent to the upstream (thus should wait for the upstream to
     * confirm. Returns false if the update is not sent and the update should be dropped.
     */
    writeUpstream, equalsPredicate = (a, b) => a === b) {
        const signal = new OWLSignal(initialValue, subscribeUpstream, writeUpstream, equalsPredicate);
        const setSignal = makeSetterWithPatches(signal.update.bind(signal));
        const emitError = (tags, error) => signal.emitWriteErrorEvent({ tags, error });
        return [signal, setSignal, emitError];
    }
    static createWithoutInitialValue(subscribeUpstream, writeUpstream, equalsPredicate = (a, b) => a === b) {
        const fullEqualsPredicate = (a, b) => {
            if (a === OWLSignal.NOT_AVAILABLE || b === OWLSignal.NOT_AVAILABLE) {
                return a === b;
            }
            return equalsPredicate(a, b);
        };
        return OWLSignal.create(OWLSignal.NOT_AVAILABLE, subscribeUpstream, writeUpstream, fullEqualsPredicate);
    }
    async update(updater, tags) {
        const { promise, reject, resolve } = makePromise();
        this.queuedUpdates.push({
            updater,
            tags: tags ?? [],
            resolve,
            reject,
        });
        this.updateOptimisticValue();
        this.ensureWriteLoop();
        return promise;
    }
    /**
     * Starts the write loop if it is not already running.
     */
    ensureWriteLoop() {
        if (!this.isWriteLoopRunning) {
            this.writeLoop(); // This is not expected to error, if it does, just default behavior
        }
    }
    /**
     * The main write loop, it will keep running until there are no more updates to process.
     */
    async writeLoop() {
        const unsubscribe = this.innerSignal.subscribe(() => { });
        this.isWriteLoopRunning = true;
        if (this.isStale()) {
            await this.innerSignal.pull();
        }
        while (this.queuedUpdates.length > 0) {
            const numQueuedUpdatesToHandle = this.queuedUpdates.length;
            const updater = (data) => {
                const patches = [];
                for (let i = 0; i < numQueuedUpdatesToHandle; i++) {
                    const [newData, newPatches] = this.queuedUpdates[i].updater(data);
                    data = newData;
                    patches.push(...newPatches);
                }
                return [data, patches];
            };
            const resolve = () => {
                for (let i = 0; i < numQueuedUpdatesToHandle; i++) {
                    this.queuedUpdates[i].resolve();
                }
            };
            const reject = (error) => {
                for (let i = 0; i < numQueuedUpdatesToHandle; i++) {
                    this.queuedUpdates[i].reject(error);
                }
            };
            const queuedUpdateTags = this.queuedUpdates.flatMap(update => update.tags);
            const tag = Date.now() + "-" + Math.random();
            await new Promise(nextStep => {
                this.isSubscriptionHandledByWriteLoop = true;
                const unsubscribeArray = [];
                const settle = () => {
                    this.isSubscriptionHandledByWriteLoop = false;
                    unsubscribeArray.forEach(unsubscribe => unsubscribe());
                    nextStep();
                };
                unsubscribeArray.push(this.innerSignal.subscribeFull((_data, _patches, tags) => {
                    if (!this.isSubscriptionHandledByWriteLoop) {
                        return;
                    }
                    if (tags?.includes(tag)) {
                        settle();
                        resolve();
                        // If this update is caused by the write, we need to remove the optimistic update
                        // and apply the remaining optimistic updates
                        this.queuedUpdates.splice(0, numQueuedUpdatesToHandle);
                        this.updateOptimisticValue(tags.filter(t => t !== tag));
                    }
                    else {
                        // This update is not caused by the write, simply update the optimistic value
                        // as normal
                        this.updateOptimisticValue(tags);
                    }
                }));
                unsubscribeArray.push(this.writeErrorEvent.subscribe(({ tags, error }) => {
                    if (!this.isSubscriptionHandledByWriteLoop) {
                        return;
                    }
                    if (tags.includes(tag)) {
                        settle();
                        reject(error);
                        this.queuedUpdates.splice(0, numQueuedUpdatesToHandle);
                    }
                }));
                // At this point, we know the data is available, because upon entering the write loop, we
                // ensure that the data is available by pulling. Hence, we can safely cast the data to
                // StripNotAvailable<TData>.
                const sent = this.writeUpstream(...updater(this.innerSignal.get()), [tag, ...queuedUpdateTags]);
                if (!sent) {
                    settle();
                    resolve();
                    this.queuedUpdates.splice(0, numQueuedUpdatesToHandle);
                    this.updateOptimisticValue(queuedUpdateTags.filter(t => t !== tag));
                }
            });
        }
        this.isWriteLoopRunning = false;
        unsubscribe();
    }
    /**
     * Returns whether the value is currently stale.
     *
     * A value is stale whenever the upstream subscription is not active. This can happen in three
     * cases:
     *
     * 1. When no subscriber is attached to this signal, the signal will not subscribe to the
     *    upstream. In this case, the value is always stale.
     * 2. When a subscriber is attached, but the upstream has not yet emitted a single value, the
     *    value is also stale.
     * 3. When the upstream has emitted an error. In this case, the subscription to the upstream is
     *    terminated and the value is stale.
     *
     * If you wish to get the current value and ensure that it is not stale, use the method
     * {@link OWLSignal#pull}.
     */
    isStale() {
        return this.innerSignal.isStale();
    }
    /**
     * Gets the current value of the signal. If the value is not available, it will return
     * {@link OWLSignal.NOT_AVAILABLE}. (A value will only be unavailable if the signal is created
     * without an initial value and the upstream has not emitted a value yet.)
     *
     * In addition, the value returned by this method may be stale. Use {@link OWLSignal#isStale} to
     * check if the value is stale.
     *
     * If you wish to get the current value and ensure that it is not stale, use the method
     * {@link OWLSignal#pull}.
     */
    get() {
        return this.outerSignal.get();
    }
    /**
     * Gets the current value of the signal pessimistically. If the value is not available, it will
     * return {@link OWLSignal.NOT_AVAILABLE}. (A value will only be unavailable if the signal is
     * created without an initial value and the upstream has not emitted a value yet.)
     */
    getPessimistic() {
        return this.innerSignal.get();
    }
    /**
     * Pulls the current value of the signal. If the value is stale, it will subscribe and wait for
     * the next value from the upstream and return it.
     *
     * You must also provide an `optimistic` flag. If `optimistic` is true, the pending optimistic
     * updates will be applied to the value before returning it.
     */
    async pull({ optimistic = true } = {}) {
        if (optimistic) {
            return this.applyOptimisticUpdates(await this.innerSignal.pull());
        }
        else {
            return this.innerSignal.pull();
        }
    }
    async ensureAvailable() {
        if (this.currentEnsureAvailablePromise === null) {
            this.currentEnsureAvailablePromise = (async () => {
                await this.innerSignal.pull();
                return this;
            })();
        }
        return this.currentEnsureAvailablePromise;
    }
    subscribe(subscriber) {
        const unsubscribeOuter = this.outerSignal.subscribe(subscriber);
        const unsubscribeInner = this.innerSignal.subscribe(() => { });
        return () => {
            unsubscribeOuter();
            unsubscribeInner();
        };
    }
    subscribeFull(subscriber) {
        const unsubscribeOuter = this.outerSignal.subscribeFull(subscriber);
        const unsubscribeInner = this.innerSignal.subscribeFull(() => { });
        return () => {
            unsubscribeOuter();
            unsubscribeInner();
        };
    }
}

function parseFileIdentifier(fileIdentifier) {
    if (!fileIdentifier.includes(":")) {
        fileIdentifier = `local:${fileIdentifier}`;
    }
    const colonIndex = fileIdentifier.indexOf(":");
    const namespace = fileIdentifier.slice(0, colonIndex);
    const content = fileIdentifier.slice(colonIndex + 1);
    switch (namespace) {
        case "local": {
            if (content.includes("/") || content.includes("\\") || content.length === 0) {
                throw new Error(`Invalid local file name: ${content}.`);
            }
            return {
                type: "local",
                fileName: content,
            };
        }
        case "base64": {
            return {
                type: "base64",
                base64Data: content,
            };
        }
        default: {
            throw new Error(`Unknown file identifier namespace: ${namespace}.`);
        }
    }
}

function promisifyAbortSignal(abortSignal) {
    return new Promise((_resolve, reject) => {
        if (abortSignal.aborted) {
            reject(abortSignal.reason);
            return;
        }
        abortSignal.addEventListener("abort", () => {
            reject(abortSignal.reason);
        }, { once: true });
    });
}
function raceWithAbortSignal(promise, abortSignal) {
    return Promise.race([promise, promisifyAbortSignal(abortSignal)]);
}

const allowableEnvVarKeys = ["HSA_OVERRIDE_GFX_VERSION"];
const allowableEnvVarKeysSchema = zod.z.enum(allowableEnvVarKeys);
const allowableEnvVarsSchema = zod.z.record(allowableEnvVarKeysSchema, zod.z.string());

const kebabCaseRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const kebabCaseSchema = zod.z.string().regex(kebabCaseRegex);
const kebabCaseWithDotsRegex = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;
const kebabCaseWithDotsSchema = zod.z.string().regex(kebabCaseWithDotsRegex);

/**
 * Matches valid file names
 */
const fileNameRegex = /^[\p{L}\p{N}!@#$%^&()\-_+=,.;'[\]{}~`][\p{L}\p{N}!@#$%^&()\-_+=,.;'[\]{}~` ]*(?<![. ])$/u;
const fileNameSchema = zod.z.string().regex(fileNameRegex, { message: "Invalid file name" });
/**
 * Matches paths like:
 *
 * a/b/c
 */
const relativePathNoLeadingDotSlashRegex = /^[\p{L}\p{N}!@#$%^&()\-_+=,.;'[\]{}~`][\p{L}\p{N}!@#$%^&()\-_+=,.;'[\]{}~` ]*(?<![. ])(?:\/[\p{L}\p{N}!@#$%^&()\-_+=,.;'[\]{}~`][\p{L}\p{N}!@#$%^&()\-_+=,.;'[\]{}~` ]*(?<![. ]))*$/u;
zod.z
    .string()
    .regex(relativePathNoLeadingDotSlashRegex, {
    message: "Invalid relative path",
});

const huggingFaceModelDownloadSourceSchema = zod.z.object({
    type: zod.z.literal("huggingface"),
    user: fileNameSchema,
    repo: fileNameSchema,
});
const modelDownloadSourceSchema = zod.z.discriminatedUnion("type", [huggingFaceModelDownloadSourceSchema]);

const artifactDependencyPurposeSchema = zod.z.enum([
    "baseModel",
    "draftModel",
    "custom",
]);
const artifactDependencyBaseSchema = zod.z.object({
    purpose: artifactDependencyPurposeSchema,
});
const artifactModelDependencySchema = zod.z.object({
    type: zod.z.literal("model"),
    ...artifactDependencyBaseSchema.shape,
    modelKeys: zod.z.array(zod.z.string().min(1)),
    sources: zod.z.array(modelDownloadSourceSchema),
});
const artifactArtifactDependencySchema = zod.z.object({
    type: zod.z.literal("artifact"),
    ...artifactDependencyBaseSchema.shape,
    owner: kebabCaseSchema,
    name: kebabCaseWithDotsSchema,
});
const artifactDependencySchema = zod.z.discriminatedUnion("type", [
    artifactModelDependencySchema,
    artifactArtifactDependencySchema,
]);
const artifactManifestBaseSchema = zod.z.object({
    owner: kebabCaseSchema,
    name: kebabCaseWithDotsSchema.min(1, "Name is required").max(100, "Name too long"),
    revision: zod.z.number().int().optional(),
    dependencies: zod.z.array(artifactDependencySchema).optional(),
    tags: zod.z.array(zod.z.string()).optional(),
});
const artifactIdentifierRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:[-.][a-z0-9]+)*$/;
const artifactIdentifierSchema = zod.z.string().regex(artifactIdentifierRegex, {
    message: "Invalid artifact identifier format. Expected 'owner/name'.",
});

const modelManifestSchema = zod.z.object({
    type: zod.z.literal("model"),
    ...artifactManifestBaseSchema.shape,
});

const pluginRunnerTypeSchema = zod.z.enum(["ecmascript", "node", "mcpBridge"]);
const pluginManifestSchema = zod.z.object({
    type: zod.z.literal("plugin"),
    runner: pluginRunnerTypeSchema,
    ...artifactManifestBaseSchema.shape,
});

const presetManifestSchema = zod.z.object({
    type: zod.z.literal("preset"),
    ...artifactManifestBaseSchema.shape,
});

zod.z.discriminatedUnion("type", [
    pluginManifestSchema,
    presetManifestSchema,
    modelManifestSchema,
]);
const artifactTypeSchema = zod.z.enum(["plugin", "preset", "model"]);

const backendNotificationSchema = zod.z.object({
    title: zod.z.string(),
    description: zod.z.string().optional(),
    noAutoDismiss: zod.z.boolean().optional(),
});

const fileTypeSchema = zod.z.enum([
    "image",
    "text/plain",
    "application/pdf",
    "application/word",
    "text/other",
    "unknown",
]);

const jsonSerializableSchema = zod.z.any().transform((val, ctx) => {
    try {
        // Needs a more performant way to do this.
        return JSON.parse(JSON.stringify(val));
    }
    catch (e) {
        ctx.addIssue({
            code: zod.z.ZodIssueCode.custom,
            message: "Not JSON serializable: " + e.message,
        });
        return val;
    }
});

const chatMessagePartTextDataSchema = zod.z.object({
    type: zod.z.literal("text"),
    text: zod.z.string(),
});
const chatMessagePartFileDataSchema = zod.z.object({
    type: zod.z.literal("file"),
    name: zod.z.string(),
    identifier: zod.z.string(),
    sizeBytes: zod.z.number().int(),
    fileType: fileTypeSchema,
});
const functionToolCallRequestSchema = zod.z.object({
    id: zod.z.string().optional(),
    type: zod.z.literal("function"),
    arguments: zod.z.record(jsonSerializableSchema).optional(),
    name: zod.z.string(),
});
const toolCallRequestSchema = zod.z.discriminatedUnion("type", [
    functionToolCallRequestSchema,
]);
const chatMessagePartToolCallRequestDataSchema = zod.z.object({
    type: zod.z.literal("toolCallRequest"),
    toolCallRequest: toolCallRequestSchema,
});
zod.z.object({
    content: zod.z.string(),
    toolCallId: zod.z.string().optional(),
});
const chatMessagePartToolCallResultDataSchema = zod.z.object({
    type: zod.z.literal("toolCallResult"),
    content: zod.z.string(),
    toolCallId: zod.z.string().optional(),
});
zod.z.discriminatedUnion("type", [
    chatMessagePartTextDataSchema,
    chatMessagePartFileDataSchema,
    chatMessagePartToolCallRequestDataSchema,
    chatMessagePartToolCallResultDataSchema,
]);
zod.z.enum(["assistant", "user", "system", "tool"]);
const chatMessageDataSchema = zod.z.discriminatedUnion("role", [
    zod.z.object({
        role: zod.z.literal("assistant"),
        content: zod.z.array(zod.z.discriminatedUnion("type", [
            chatMessagePartTextDataSchema,
            chatMessagePartFileDataSchema,
            chatMessagePartToolCallRequestDataSchema,
        ])),
    }),
    zod.z.object({
        role: zod.z.literal("user"),
        content: zod.z.array(zod.z.discriminatedUnion("type", [chatMessagePartTextDataSchema, chatMessagePartFileDataSchema])),
    }),
    zod.z.object({
        role: zod.z.literal("system"),
        content: zod.z.array(zod.z.discriminatedUnion("type", [chatMessagePartTextDataSchema, chatMessagePartFileDataSchema])),
    }),
    zod.z.object({
        role: zod.z.literal("tool"),
        content: zod.z.array(chatMessagePartToolCallResultDataSchema),
    }),
]);
const chatHistoryDataSchema = zod.z.object({
    messages: zod.z.array(chatMessageDataSchema),
});

const citationSourceSchema = zod.z.object({
    fileName: zod.z.string(),
    absoluteFilePath: zod.z.string().optional(),
    pageNumber: zod.z.union([zod.z.number().int(), zod.z.tuple([zod.z.number().int(), zod.z.number().int()])]).optional(),
    lineNumber: zod.z.union([zod.z.number().int(), zod.z.tuple([zod.z.number().int(), zod.z.number().int()])]).optional(),
});

/**
 * @deprecated Use colorPaletteSchema instead.
 */
const colorPalette = zod.z.enum([
    "red",
    "green",
    "blue",
    "yellow",
    "orange",
    "purple",
    "default",
]);
const colorPaletteSchema = colorPalette;

const diagnosticsLogEventDataSchema = zod.z.discriminatedUnion("type", [
    zod.z.object({
        type: zod.z.literal("llm.prediction.input"),
        modelPath: zod.z.string(),
        modelIdentifier: zod.z.string(),
        input: zod.z.string(),
    }),
]);
const diagnosticsLogEventSchema = zod.z.object({
    timestamp: zod.z.number(),
    data: diagnosticsLogEventDataSchema,
});

const llmLlamaAccelerationOffloadRatioSchema = zod.z.union([
    zod.z.number().min(0).max(1),
    zod.z.literal("max"),
    zod.z.literal("off"),
]);
const llmSplitStrategySchema = zod.z.enum(["evenly", "favorMainGpu"]);
const gpuSettingSchema = zod.z.object({
    ratio: llmLlamaAccelerationOffloadRatioSchema.optional(),
    mainGpu: zod.z.number().int().optional(),
    splitStrategy: llmSplitStrategySchema.optional(),
    disabledGpus: zod.z.array(zod.z.number().int()).optional(),
});
const llmLlamaCacheQuantizationTypes = [
    "f32",
    "f16",
    "q8_0",
    "q4_0",
    "q4_1",
    "iq4_nl",
    "q5_0",
    "q5_1",
];
const llmLlamaCacheQuantizationTypeSchema = zod.z.enum(llmLlamaCacheQuantizationTypes);
const llmMlxKvCacheBitsTypeSchema = zod.z.union([
    zod.z.literal(8),
    zod.z.literal(6),
    zod.z.literal(4),
    zod.z.literal(3),
    zod.z.literal(2),
]);
const llmMlxKvCacheGroupSizeTypesSchema = zod.z.union([
    zod.z.literal(32),
    zod.z.literal(64),
    zod.z.literal(128),
]);
const llmMlxKvCacheQuantizationSchema = zod.z.object({
    enabled: zod.z.boolean(),
    bits: llmMlxKvCacheBitsTypeSchema,
    groupSize: llmMlxKvCacheGroupSizeTypesSchema,
    quantizedStart: zod.z.number().int().nonnegative(),
});
const llmLoadModelConfigSchema = zod.z.object({
    gpu: gpuSettingSchema.optional(),
    gpuStrictVramCap: zod.z.boolean().optional(),
    offloadKVCacheToGpu: zod.z.boolean().optional(),
    contextLength: zod.z.number().int().min(1).optional(),
    ropeFrequencyBase: zod.z.number().optional(),
    ropeFrequencyScale: zod.z.number().optional(),
    evalBatchSize: zod.z.number().int().min(1).optional(),
    flashAttention: zod.z.boolean().optional(),
    keepModelInMemory: zod.z.boolean().optional(),
    seed: zod.z.number().int().optional(),
    useFp16ForKVCache: zod.z.boolean().optional(),
    tryMmap: zod.z.boolean().optional(),
    numExperts: zod.z.number().int().optional(),
    llamaKCacheQuantizationType: zod.z
        .enum(llmLlamaCacheQuantizationTypes)
        .or(zod.z.literal(false))
        .optional(),
    llamaVCacheQuantizationType: zod.z
        .enum(llmLlamaCacheQuantizationTypes)
        .or(zod.z.literal(false))
        .optional(),
});

const embeddingLoadModelConfigSchema = zod.z.object({
    gpu: gpuSettingSchema.optional(),
    contextLength: zod.z.number().int().min(1).optional(),
    ropeFrequencyBase: zod.z.number().optional(),
    ropeFrequencyScale: zod.z.number().optional(),
    keepModelInMemory: zod.z.boolean().optional(),
    tryMmap: zod.z.boolean().optional(),
});

const modelCompatibilityTypeSchema = zod.z.enum([
    "gguf",
    "safetensors",
    "onnx",
    "ggml",
    "mlx_placeholder",
    "torch_safetensors",
]);

const quantizationSchema = zod.z.object({
    name: zod.z.string(),
    bits: zod.z.number().int(),
});

const modelInfoBaseSchema = zod.z.object({
    modelKey: zod.z.string(),
    format: modelCompatibilityTypeSchema,
    displayName: zod.z.string(),
    path: zod.z.string(),
    sizeBytes: zod.z.number().int(),
    paramsString: zod.z.string().optional(),
    architecture: zod.z.string().optional(),
    quantization: quantizationSchema.optional(),
});
const modelInstanceInfoBaseSchema = modelInfoBaseSchema.extend({
    identifier: zod.z.string(),
    instanceReference: zod.z.string(),
});

const embeddingModelAdditionalInfoSchema = zod.z.object({
    maxContextLength: zod.z.number().int(),
});
const embeddingModelInstanceAdditionalInfoSchema = zod.z.object({
    contextLength: zod.z.number().int(),
});
const embeddingModelInfoSchema = zod.z
    .object({
    type: zod.z.literal("embedding"),
})
    .extend(modelInfoBaseSchema.shape)
    .extend(embeddingModelAdditionalInfoSchema.shape);
const embeddingModelInstanceInfoSchema = zod.z
    .object({ type: zod.z.literal("embedding") })
    .extend(modelInstanceInfoBaseSchema.shape)
    .extend(embeddingModelAdditionalInfoSchema.shape)
    .extend(embeddingModelInstanceAdditionalInfoSchema.shape);

const modelDomainTypeSchema = zod.z.enum([
    "llm",
    "embedding",
    "imageGen",
    "transcription",
    "tts",
]);

/**
 * A string that is reasonable to use as a key. For example, as preset name, model path, or model
 * identifier.
 */
const reasonableKeyStringSchema = zod.z
    .string()
    .min(1)
    .max(1024)
    .refine(value => value !== "__proto__", {
    message: 'For security reasons, "__proto__" is not allowed',
})
    .refine(value => /\p{C}/u.test(value) === false, {
    message: "Control characters are not allowed",
});

const modelQuerySchema = zod.z.object({
    domain: modelDomainTypeSchema.optional(),
    identifier: reasonableKeyStringSchema.optional(),
    path: reasonableKeyStringSchema.optional(),
    vision: zod.z.boolean().optional(),
});
const modelSpecifierSchema = zod.z.discriminatedUnion("type", [
    zod.z.object({
        type: zod.z.literal("query"),
        query: modelQuerySchema,
    }),
    zod.z.object({
        type: zod.z.literal("instanceReference"),
        instanceReference: zod.z.string(),
    }),
]);

const genericErrorDisplayDataSchema = [
    zod.z.object({
        code: zod.z.literal("generic.specificModelUnloaded"),
    }),
    zod.z.object({
        code: zod.z.literal("generic.noModelMatchingQuery"),
        query: modelQuerySchema,
        loadedModelsSample: zod.z.array(zod.z.string()),
        totalLoadedModels: zod.z.number().int(),
    }),
    zod.z.object({
        code: zod.z.literal("generic.pathNotFound"),
        path: zod.z.string(),
        availablePathsSample: zod.z.array(zod.z.string()),
        totalModels: zod.z.number().int(),
    }),
    zod.z.object({
        code: zod.z.literal("generic.identifierNotFound"),
        identifier: zod.z.string(),
        loadedModelsSample: zod.z.array(zod.z.string()),
        totalLoadedModels: zod.z.number().int(),
    }),
    zod.z.object({
        code: zod.z.literal("generic.domainMismatch"),
        path: zod.z.string(),
        actualDomain: modelDomainTypeSchema,
        expectedDomain: modelDomainTypeSchema,
    }),
    zod.z.object({
        code: zod.z.literal("generic.engineDoesNotSupportFeature"),
        feature: zod.z.string(),
        engineName: zod.z.string(),
        engineType: zod.z.string(),
        installedVersion: zod.z.string(),
        supportedVersion: zod.z.string().nullable(),
    }),
    zod.z.object({
        code: zod.z.literal("generic.presetNotFound"),
        specifiedFuzzyPresetIdentifier: zod.z.string(),
        availablePresetsSample: zod.z.array(zod.z.object({
            identifier: zod.z.string(),
            name: zod.z.string(),
        })),
        totalAvailablePresets: zod.z.number().int(),
    }),
];

const llmErrorDisplayDataSchema = [];

const errorDisplayDataSchema = zod.z.discriminatedUnion("code", [
    ...llmErrorDisplayDataSchema,
    ...genericErrorDisplayDataSchema,
]);
/**
 * Makes a Zod schema that turns a failed parse into an `undefined`.
 */
function failOk(schema) {
    return zod.z.any().transform(val => (schema.safeParse(val).success ? val : undefined));
}
const serializedLMSExtendedErrorSchema = zod.z.object({
    title: failOk(zod.z.string()).default("Unknown error"),
    cause: failOk(zod.z.string()).optional(),
    suggestion: failOk(zod.z.string()).optional(),
    errorData: failOk(zod.z.record(zod.z.string(), zod.z.unknown())).optional(),
    displayData: failOk(errorDisplayDataSchema).optional(),
    stack: failOk(zod.z.string()).optional(),
    rootTitle: failOk(zod.z.string()).optional(),
});
function serializeError(error) {
    if (typeof error === "object") {
        const title = error.title ?? error.lmstudioRawError ?? error.message ?? "Unknown error";
        return serializedLMSExtendedErrorSchema.parse({
            title,
            cause: error.cause,
            suggestion: error.suggestion,
            errorData: error.errorData,
            displayData: error.displayData,
            stack: error.stack,
            rootTitle: title,
        });
    }
    else {
        const title = String(error);
        return {
            title,
            rootTitle: title,
        };
    }
}
/**
 * Attaches the additional error data from a serialized error to an error object.
 */
function attachSerializedErrorData(error, serialized) {
    const untypedError = error;
    untypedError.title = serialized.title;
    if (serialized.cause !== undefined) {
        untypedError.cause = serialized.cause;
    }
    if (serialized.suggestion !== undefined) {
        untypedError.suggestion = serialized.suggestion;
    }
    if (serialized.errorData !== undefined) {
        untypedError.errorData = serialized.errorData;
    }
}
function fromSerializedError(error, message = "Rehydrated error", replacementStack) {
    const result = new Error(error.rootTitle);
    attachSerializedErrorData(result, error);
    if (error.displayData !== undefined) {
        result.displayData = error.displayData;
    }
    if (replacementStack !== undefined) {
        if (error.stack !== undefined) {
            result.stack = `Error: ${message}\n${replacementStack}\n- Caused By: ${error.stack}`;
        }
        else {
            result.stack = `Error: ${message}\n${replacementStack}`;
        }
    }
    else {
        if (error.stack !== undefined) {
            result.stack =
                `Error: ${message}\n${result.stack.substring(error.stack.indexOf("\n") + 1)}\n- Caused By: ` +
                    error.stack;
        }
        else {
            result.message += ` - caused by error without stack (${error.title})`;
        }
    }
    return result;
}

const documentParsingLibraryIdentifierSchema = zod.z.object({
    library: zod.z.string(),
    version: zod.z.string(),
});
const documentParsingOptsSchema = zod.z.object({
    parserId: documentParsingLibraryIdentifierSchema.optional(),
});

zod.z.enum(["local", "base64"]);
zod.z.discriminatedUnion("type", [
    zod.z.object({
        type: zod.z.literal("local"),
        fileName: zod.z.string(),
    }),
    zod.z.object({
        type: zod.z.literal("base64"),
        base64Data: zod.z.string(),
    }),
]);

const gpuSplitStrategies = ["evenly", "priorityOrder", "custom"];
const gpuSplitStrategySchema = zod.z.enum(gpuSplitStrategies);
const defaultGPUSplitConfig = {
    strategy: "evenly",
    disabledGpus: [],
    priority: [],
    customRatio: [],
};
const gpuSplitConfigSchema = zod.z.object({
    strategy: gpuSplitStrategySchema,
    disabledGpus: zod.z.array(zod.z.number().int().min(0)),
    priority: zod.z.array(zod.z.number().int().min(0)),
    customRatio: zod.z.array(zod.z.number().min(0)),
});
function convertGPUSettingToGPUSplitConfig(gpuSetting) {
    return {
        strategy: gpuSetting?.splitStrategy == "favorMainGpu"
            ? "priorityOrder"
            : gpuSetting?.splitStrategy ?? "evenly",
        disabledGpus: gpuSetting?.disabledGpus ?? [],
        priority: gpuSetting?.mainGpu ? [gpuSetting.mainGpu] : [],
        customRatio: [],
    };
}

const kvConfigFieldSchema = zod.z.object({
    key: zod.z.string(),
    value: zod.z.any(),
});
const kvConfigSchema = zod.z.object({
    fields: zod.z.array(kvConfigFieldSchema),
});
const kvConfigLayerNameSchema = zod.z.enum([
    "currentlyEditing",
    "currentlyLoaded",
    "apiOverride",
    "conversationSpecific",
    "conversationGlobal",
    "preset",
    "serverSession",
    "httpServerRequestOverride",
    "completeModeFormatting",
    "instance",
    "userModelDefault",
    "virtualModel",
    "modelDefault",
    "hardware",
]);
const kvConfigStackLayerSchema = zod.z.object({
    layerName: kvConfigLayerNameSchema,
    config: kvConfigSchema,
});
const kvConfigStackSchema = zod.z.object({
    layers: zod.z.array(kvConfigStackLayerSchema),
});
const kvConfigFieldDependencySchema = zod.z.object({
    key: zod.z.string(),
    condition: zod.z.discriminatedUnion("type", [
        zod.z.object({ type: zod.z.literal("equals"), value: zod.z.any() }),
        zod.z.object({ type: zod.z.literal("notEquals"), value: zod.z.any() }),
    ]),
});

const contentBlockStyleSchema = zod.z.discriminatedUnion("type", [
    zod.z.object({
        type: zod.z.literal("default"),
    }),
    zod.z.object({
        type: zod.z.literal("customLabel"),
        label: zod.z.string(),
        color: zod.z.optional(colorPaletteSchema),
    }),
    zod.z.object({
        type: zod.z.literal("thinking"),
        ended: zod.z.boolean().optional(),
        title: zod.z.string().optional(),
    }),
]);

const llmToolParametersSchema = zod.z.discriminatedUnion("type", [
    zod.z.object({
        type: zod.z.literal("object"),
        properties: zod.z.record(jsonSerializableSchema),
        required: zod.z.array(zod.z.string()).optional(),
        additionalProperties: zod.z.boolean().optional(),
        $defs: zod.z.record(jsonSerializableSchema).optional(),
    }),
    // add more parameter types here
    // ...
]);
const llmToolSchema = zod.z.discriminatedUnion("type", [
    zod.z.object({
        type: zod.z.literal("function"),
        function: zod.z.object({
            name: zod.z.string(),
            description: zod.z.string().optional(),
            parameters: llmToolParametersSchema.optional(),
        }),
    }),
    // add more tool types here
    // ...
]);
/**
 * For convenience
 */
zod.z.array(llmToolSchema);
const llmToolUseSettingSchema = zod.z.discriminatedUnion("type", [
    zod.z.object({
        type: zod.z.literal("none"),
    }),
    zod.z.object({
        type: zod.z.literal("toolArray"),
        tools: zod.z.array(llmToolSchema).optional(),
        force: zod.z.boolean().optional(),
    }),
]);

const llmApplyPromptTemplateOptsSchema = zod.z.object({
    omitBosToken: zod.z.boolean().optional(),
    omitEosToken: zod.z.boolean().optional(),
    toolDefinitions: zod.z.array(llmToolSchema).optional(),
});

const llmContextReferenceSchema = zod.z.discriminatedUnion("type", [
    zod.z.object({
        type: zod.z.literal("jsonFile"),
        absPath: zod.z.string(),
    }),
    zod.z.object({
        type: zod.z.literal("yamlFile"),
        absPath: zod.z.string(),
    }),
]);
zod.z.array(zod.z.object({
    role: zod.z.enum(["user", "assistant", "system"]),
    content: zod.z.string(),
}));
zod.z.array(zod.z.union([
    zod.z.object({
        system: zod.z.string(),
    }),
    zod.z.object({
        user: zod.z.string(),
    }),
    zod.z.object({
        assistant: zod.z.string(),
    }),
]));

const llmAdditionalInfoSchema = zod.z.object({
    vision: zod.z.boolean(),
    trainedForToolUse: zod.z.boolean(),
    maxContextLength: zod.z.number().int(),
});
const llmInstanceAdditionalInfoSchema = zod.z.object({
    contextLength: zod.z.number().int(),
});
const llmInfoSchema = zod.z
    .object({
    type: zod.z.literal("llm"),
})
    .extend(modelInfoBaseSchema.shape)
    .extend(llmAdditionalInfoSchema.shape);
const llmInstanceInfoSchema = zod.z
    .object({
    type: zod.z.literal("llm"),
})
    .extend(modelInstanceInfoBaseSchema.shape)
    .extend(llmAdditionalInfoSchema.shape)
    .extend(llmInstanceAdditionalInfoSchema.shape);

const toolNamingSchema = zod.z.enum(["passThrough", "removeSpecial", "snakeCase", "camelCase"]);

/**
 * Check if has a parse method. If not, output error message asking for it to be a zod schema.
 */
const zodSchemaSchema = zod.z.custom(value => {
    if (typeof value?.parse !== "function") {
        return false;
    }
    return true;
}, "Expected a zod schema");

const llmManualPromptTemplateSchema = zod.z.object({
    beforeSystem: zod.z.string(),
    afterSystem: zod.z.string(),
    beforeUser: zod.z.string(),
    afterUser: zod.z.string(),
    beforeAssistant: zod.z.string(),
    afterAssistant: zod.z.string(),
});
const llmJinjaPromptTemplateSchema = zod.z.object({
    template: zod.z.string(),
});
const llmPromptTemplateTypeSchema = zod.z.enum(["manual", "jinja"]);
const llmPromptTemplateSchema = zod.z.object({
    type: llmPromptTemplateTypeSchema,
    manualPromptTemplate: llmManualPromptTemplateSchema.optional(),
    jinjaPromptTemplate: llmJinjaPromptTemplateSchema.optional(),
    stopStrings: zod.z.array(zod.z.string()),
});

const llmStructuredPredictionTypeSchema = zod.z.enum(["none", "json", "gbnf"]);
const llmStructuredPredictionSettingSchema = zod.z.object({
    type: llmStructuredPredictionTypeSchema,
    jsonSchema: jsonSerializableSchema.optional(),
    gbnfGrammar: zod.z.string().optional(),
});

const llmContextOverflowPolicySchema = zod.z.enum([
    "stopAtLimit",
    "truncateMiddle",
    "rollingWindow",
]);
const llmReasoningParsingSchema = zod.z.object({
    enabled: zod.z.boolean(),
    startString: zod.z.string(),
    endString: zod.z.string(),
});
const llmPredictionConfigInputSchema = zod.z.object({
    maxTokens: zod.z.number().int().min(-1).optional().or(zod.z.literal(false)),
    temperature: zod.z.number().min(0).optional(),
    stopStrings: zod.z.array(zod.z.string()).optional(),
    toolCallStopStrings: zod.z.array(zod.z.string()).optional(),
    contextOverflowPolicy: llmContextOverflowPolicySchema.optional(),
    structured: zod.z.union([zodSchemaSchema, llmStructuredPredictionSettingSchema]).optional(),
    rawTools: llmToolUseSettingSchema.optional(),
    toolNaming: toolNamingSchema.optional(),
    topKSampling: zod.z.number().optional(),
    repeatPenalty: zod.z.number().optional().or(zod.z.literal(false)),
    minPSampling: zod.z.number().optional().or(zod.z.literal(false)),
    topPSampling: zod.z.number().optional().or(zod.z.literal(false)),
    cpuThreads: zod.z.number().int().optional(),
    promptTemplate: llmPromptTemplateSchema.optional(),
    draftModel: zod.z.string().optional(),
    speculativeDecodingNumDraftTokensExact: zod.z.number().int().min(1).optional(),
    speculativeDecodingMinDraftLengthToConsider: zod.z.number().int().min(0).optional(),
    speculativeDecodingMinContinueDraftingProbability: zod.z.number().optional(),
    reasoningParsing: llmReasoningParsingSchema.optional(),
    raw: kvConfigSchema.optional(),
});
zod.z.object({
    ...llmPredictionConfigInputSchema.shape,
    structured: llmStructuredPredictionSettingSchema.optional(),
});
const llmLlamaMirostatSamplingConfigSchema = zod.z.object({
    version: zod.z.union([zod.z.literal(0), zod.z.literal(1), zod.z.literal(2)]),
    learningRate: zod.z.number(),
    targetEntropy: zod.z.number(),
});
const llmLlamaSingleLogitBiasModificationSchema = zod.z.union([zod.z.number(), zod.z.literal("-inf")]);
const llmLlamaLogitBiasConfigSchema = zod.z.array(zod.z.tuple([zod.z.number(), llmLlamaSingleLogitBiasModificationSchema]));

const llmPredictionFragmentReasoningTypeSchema = zod.z.enum([
    "none",
    "reasoning",
    "reasoningStartTag",
    "reasoningEndTag",
]);
const llmPredictionFragmentSchema = zod.z.object({
    content: zod.z.string(),
    tokensCount: zod.z.number().int(),
    containsDrafted: zod.z.boolean(),
    reasoningType: llmPredictionFragmentReasoningTypeSchema,
    isStructural: zod.z.boolean(),
});
const llmPredictionFragmentInputOptsSchema = zod.z.object({
    tokenCount: zod.z.number().int().optional(),
    containsDrafted: zod.z.boolean().optional(),
    reasoningType: llmPredictionFragmentReasoningTypeSchema.optional(),
    isStructural: zod.z.boolean().optional(),
});

const llmPredictionStopReasonSchema = zod.z.enum([
    "userStopped",
    "modelUnloaded",
    "failed",
    "eosFound",
    "stopStringFound",
    "toolCalls",
    "maxPredictedTokensReached",
    "contextLengthReached",
]);
const llmPredictionStatsSchema = zod.z.object({
    stopReason: llmPredictionStopReasonSchema,
    tokensPerSecond: zod.z.number().optional(),
    numGpuLayers: zod.z.number().optional(),
    timeToFirstTokenSec: zod.z.number().optional(),
    totalTimeSec: zod.z.number().optional(),
    promptTokensCount: zod.z.number().int().optional(),
    predictedTokensCount: zod.z.number().int().optional(),
    totalTokensCount: zod.z.number().int().optional(),
    usedDraftModelKey: zod.z.string().optional(),
    totalDraftTokensCount: zod.z.number().int().optional(),
    acceptedDraftTokensCount: zod.z.number().int().optional(),
    rejectedDraftTokensCount: zod.z.number().int().optional(),
    ignoredDraftTokensCount: zod.z.number().int().optional(),
});
const llmGenInfoSchema = zod.z.object({
    indexedModelIdentifier: zod.z.string(),
    identifier: zod.z.string(),
    loadModelConfig: kvConfigSchema,
    predictionConfig: kvConfigSchema,
    stats: llmPredictionStatsSchema,
});

const blockLocationSchema = zod.z.discriminatedUnion("type", [
    zod.z.object({
        type: zod.z.literal("beforeId"),
        id: zod.z.string(),
    }),
    zod.z.object({
        type: zod.z.literal("afterId"),
        id: zod.z.string(),
    }),
]);
const statusStepStatusSchema = zod.z.enum([
    "waiting",
    "loading",
    "done",
    "error",
    "canceled",
]);
const statusStepStateSchema = zod.z.object({
    status: statusStepStatusSchema,
    text: zod.z.string(),
});
const processingUpdateStatusCreateSchema = zod.z.object({
    type: zod.z.literal("status.create"),
    id: zod.z.string(),
    state: statusStepStateSchema,
    location: blockLocationSchema.optional(),
    indentation: zod.z.number().int().optional(),
});
const processingUpdateStatusUpdateSchema = zod.z.object({
    type: zod.z.literal("status.update"),
    id: zod.z.string(),
    state: statusStepStateSchema,
});
const processingUpdateStatusRemoveSchema = zod.z.object({
    type: zod.z.literal("status.remove"),
    id: zod.z.string(),
});
const processingUpdateCitationBlockCreateSchema = zod.z.object({
    type: zod.z.literal("citationBlock.create"),
    id: zod.z.string(),
    citedText: zod.z.string(),
    fileName: zod.z.string(),
    fileIdentifier: zod.z.string(),
    pageNumber: zod.z.union([zod.z.number().int(), zod.z.tuple([zod.z.number().int(), zod.z.number().int()])]).optional(),
    lineNumber: zod.z.union([zod.z.number().int(), zod.z.tuple([zod.z.number().int(), zod.z.number().int()])]).optional(),
});
const processingUpdateDebugInfoBlockCreateSchema = zod.z.object({
    type: zod.z.literal("debugInfoBlock.create"),
    id: zod.z.string(),
    debugInfo: zod.z.string(),
});
const processingUpdateContentBlockCreateSchema = zod.z.object({
    type: zod.z.literal("contentBlock.create"),
    id: zod.z.string(),
    includeInContext: zod.z.boolean(),
    roleOverride: zod.z.enum(["user", "assistant", "system", "tool"]).optional(),
    style: contentBlockStyleSchema.optional(),
    prefix: zod.z.string().optional(),
    suffix: zod.z.string().optional(),
});
const processingUpdateContentBlockAppendTextSchema = zod.z.object({
    type: zod.z.literal("contentBlock.appendText"),
    id: zod.z.string(),
    text: zod.z.string(),
    tokensCount: zod.z.number().int().optional(),
    fromDraftModel: zod.z.boolean().optional(),
    isStructural: zod.z.boolean().optional(),
});
const processingUpdateContentBlockAppendToolResultSchema = zod.z.object({
    type: zod.z.literal("contentBlock.appendToolResult"),
    id: zod.z.string(),
    callId: zod.z.number().int(),
    toolCallRequestId: zod.z.string().optional(),
    content: zod.z.string(),
});
const processingUpdateContentBlockAppendToolRequestSchema = zod.z.object({
    type: zod.z.literal("contentBlock.appendToolRequest"),
    id: zod.z.string(),
    callId: zod.z.number().int(),
    toolCallRequestId: zod.z.string().optional(),
    name: zod.z.string(),
    parameters: zod.z.record(zod.z.unknown()),
    pluginIdentifier: zod.z.string().optional(),
});
const processingUpdateContentBlockReplaceToolRequestSchema = zod.z.object({
    type: zod.z.literal("contentBlock.replaceToolRequest"),
    id: zod.z.string(),
    callId: zod.z.number().int(),
    toolCallRequestId: zod.z.string().optional(),
    name: zod.z.string(),
    parameters: zod.z.record(zod.z.unknown()),
    pluginIdentifier: zod.z.string().optional(),
});
const processingUpdateContentBlockReplaceTextSchema = zod.z.object({
    type: zod.z.literal("contentBlock.replaceText"),
    id: zod.z.string(),
    text: zod.z.string(),
});
const processingUpdateContentBlockSetPrefixSchema = zod.z.object({
    type: zod.z.literal("contentBlock.setPrefix"),
    id: zod.z.string(),
    prefix: zod.z.string(),
});
const processingUpdateContentBlockSetSuffixSchema = zod.z.object({
    type: zod.z.literal("contentBlock.setSuffix"),
    id: zod.z.string(),
    suffix: zod.z.string(),
});
const processingUpdateContentBlockAttachGenInfoSchema = zod.z.object({
    type: zod.z.literal("contentBlock.attachGenInfo"),
    id: zod.z.string(),
    genInfo: llmGenInfoSchema,
});
const processingUpdateContentBlockSetStyleSchema = zod.z.object({
    type: zod.z.literal("contentBlock.setStyle"),
    id: zod.z.string(),
    style: contentBlockStyleSchema,
});
const toolStatusStepStateStatusSchema = zod.z.discriminatedUnion("type", [
    zod.z.object({
        type: zod.z.literal("generatingToolCall"),
        name: zod.z.string().optional(),
        pluginIdentifier: zod.z.string().optional(),
        argumentsString: zod.z.string().optional(),
    }),
    zod.z.object({
        type: zod.z.literal("toolCallGenerationFailed"),
        error: zod.z.string(),
        rawContent: zod.z.string().optional(),
    }),
    zod.z.object({
        type: zod.z.literal("toolCallQueued"),
    }),
    zod.z.object({
        type: zod.z.literal("confirmingToolCall"),
    }),
    zod.z.object({
        type: zod.z.literal("toolCallDenied"),
        denyReason: zod.z.string().optional(),
    }),
    zod.z.object({
        type: zod.z.literal("callingTool"),
    }),
    zod.z.object({
        type: zod.z.literal("toolCallFailed"),
        error: zod.z.string(),
    }),
    zod.z.object({
        type: zod.z.literal("toolCallSucceeded"),
        timeMs: zod.z.number().int(),
    }),
]);
const toolStatusStepStateSchema = zod.z.object({
    status: toolStatusStepStateStatusSchema,
    customStatus: zod.z.string(),
    customWarnings: zod.z.array(zod.z.string()),
});
const processingUpdateToolStatusCreateSchema = zod.z.object({
    type: zod.z.literal("toolStatus.create"),
    id: zod.z.string(),
    callId: zod.z.number().int(),
    state: toolStatusStepStateSchema,
});
const processingUpdateToolStatusUpdateSchema = zod.z.object({
    type: zod.z.literal("toolStatus.update"),
    id: zod.z.string(),
    state: toolStatusStepStateSchema,
});
const processingUpdateToolStatusArgumentFragmentSchema = zod.z.object({
    type: zod.z.literal("toolStatus.argumentFragment"),
    id: zod.z.string(),
    content: zod.z.string(),
});
const processingUpdateSetSenderNameSchema = zod.z.object({
    type: zod.z.literal("setSenderName"),
    name: zod.z.string(),
});
const processingUpdateSchema = zod.z.discriminatedUnion("type", [
    processingUpdateStatusCreateSchema,
    processingUpdateStatusUpdateSchema,
    processingUpdateStatusRemoveSchema,
    processingUpdateCitationBlockCreateSchema,
    processingUpdateDebugInfoBlockCreateSchema,
    processingUpdateContentBlockCreateSchema,
    processingUpdateContentBlockAppendTextSchema,
    processingUpdateContentBlockAppendToolRequestSchema,
    processingUpdateContentBlockReplaceToolRequestSchema,
    processingUpdateContentBlockAppendToolResultSchema,
    processingUpdateContentBlockReplaceTextSchema,
    processingUpdateContentBlockSetPrefixSchema,
    processingUpdateContentBlockSetSuffixSchema,
    processingUpdateContentBlockAttachGenInfoSchema,
    processingUpdateContentBlockSetStyleSchema,
    processingUpdateToolStatusCreateSchema,
    processingUpdateToolStatusUpdateSchema,
    processingUpdateToolStatusArgumentFragmentSchema,
    processingUpdateSetSenderNameSchema,
]);

zod.z.discriminatedUnion("type", [
    processingUpdateStatusCreateSchema,
    processingUpdateStatusUpdateSchema,
    processingUpdateStatusRemoveSchema,
    processingUpdateCitationBlockCreateSchema,
    processingUpdateDebugInfoBlockCreateSchema,
    processingUpdateContentBlockCreateSchema,
    processingUpdateContentBlockAppendTextSchema,
    processingUpdateContentBlockReplaceTextSchema,
    processingUpdateContentBlockAppendToolRequestSchema,
    processingUpdateContentBlockReplaceToolRequestSchema,
    processingUpdateContentBlockAppendToolResultSchema,
    processingUpdateContentBlockAttachGenInfoSchema,
    processingUpdateContentBlockSetStyleSchema,
    processingUpdateToolStatusCreateSchema,
    processingUpdateToolStatusUpdateSchema,
    processingUpdateToolStatusArgumentFragmentSchema,
    processingUpdateSetSenderNameSchema,
]);

const processingRequestConfirmToolCallSchema = zod.z.object({
    type: zod.z.literal("confirmToolCall"),
    callId: zod.z.number().int(),
    pluginIdentifier: zod.z.string().optional(),
    name: zod.z.string(),
    parameters: zod.z.record(zod.z.any()),
});
const processingRequestTextInputSchema = zod.z.object({
    type: zod.z.literal("textInput"),
    prompt: zod.z.string(),
});
const processingRequestSchema = zod.z.discriminatedUnion("type", [
    processingRequestConfirmToolCallSchema,
    processingRequestTextInputSchema,
]);
const processingRequestResponseConfirmToolCallSchema = zod.z.object({
    type: zod.z.literal("confirmToolCall"),
    result: zod.z.discriminatedUnion("type", [
        zod.z.object({
            type: zod.z.literal("allow"),
            toolArgsOverride: zod.z.record(zod.z.any()).optional(),
        }),
        zod.z.object({
            type: zod.z.literal("deny"),
            denyReason: zod.z.string().optional(),
        }),
    ]),
});
const processingRequestResponseTextInputSchema = zod.z.object({
    type: zod.z.literal("textInput"),
    result: zod.z.string(),
});
const processingRequestResponseSchema = zod.z.discriminatedUnion("type", [
    processingRequestResponseConfirmToolCallSchema,
    processingRequestResponseTextInputSchema,
]);

zod.z.object({
    modelTag: zod.z.string().optional(),
    ignoreUserConfig: zod.z.boolean().optional(),
});

zod.z.discriminatedUnion("type", [
    processingUpdateStatusCreateSchema,
    processingUpdateStatusUpdateSchema,
    processingUpdateStatusRemoveSchema,
    processingUpdateCitationBlockCreateSchema,
    processingUpdateDebugInfoBlockCreateSchema,
]);

const tokenSourceIdentifierSchema = zod.z.discriminatedUnion("type", [
    zod.z.object({
        type: zod.z.literal("model"),
        identifier: zod.z.string(),
    }),
    zod.z.object({
        type: zod.z.literal("generator"),
        pluginIdentifier: zod.z.string(),
    }),
]);

const modelInfoSchema = zod.z.discriminatedUnion("type", [
    llmInfoSchema,
    embeddingModelInfoSchema,
]);
const modelInstanceInfoSchema = zod.z.discriminatedUnion("type", [
    llmInstanceInfoSchema,
    embeddingModelInstanceInfoSchema,
]);

const pluginConfigSpecifierSchema = zod.z.discriminatedUnion("type", [
    zod.z.object({
        type: zod.z.literal("direct"),
        config: kvConfigSchema,
        workingDirectoryPath: zod.z.string().optional(),
    }),
    zod.z.object({
        type: zod.z.literal("predictionProcess"),
        pci: zod.z.string(),
        token: zod.z.string(),
    }),
]);

const remotePluginInfoSchema = zod.z.object({
    identifier: zod.z.string(),
    isDev: zod.z.boolean(),
    isTrusted: zod.z.boolean(),
    hasPromptPreprocessor: zod.z.boolean(),
    hasPredictionLoopHandler: zod.z.boolean(),
    hasToolsProvider: zod.z.boolean(),
    hasGenerator: zod.z.boolean(),
});

const artifactDownloadPlanModelInfoSchema = zod.z.object({
    displayName: zod.z.string(),
    sizeBytes: zod.z.number(),
    quantName: zod.z.string().optional(),
    compatibilityType: modelCompatibilityTypeSchema,
});
const artifactDownloadPlanNodeStateSchema = zod.z.enum(["pending", "fetching", "satisfied", "completed"]);
const artifactDownloadPlanNodeSchema = zod.z.discriminatedUnion("type", [
    zod.z.object({
        type: zod.z.literal("artifact"),
        owner: kebabCaseSchema,
        name: kebabCaseWithDotsSchema,
        state: artifactDownloadPlanNodeStateSchema,
        artifactType: artifactTypeSchema.optional(),
        sizeBytes: zod.z.number().int().optional(),
        dependencyNodes: zod.z.array(zod.z.number().int()),
    }),
    zod.z.object({
        type: zod.z.literal("model"),
        state: artifactDownloadPlanNodeStateSchema,
        resolvedSources: zod.z.number().int().optional(),
        totalSources: zod.z.number().int().optional(),
        alreadyOwned: artifactDownloadPlanModelInfoSchema.optional(),
        selected: artifactDownloadPlanModelInfoSchema.optional(),
    }),
]);
const artifactDownloadPlanSchema = zod.z.object({
    nodes: zod.z.array(artifactDownloadPlanNodeSchema),
    downloadSizeBytes: zod.z.number().int(),
});

const localArtifactFileEntrySchema = zod.z.object({
    relativePath: zod.z.string(),
    sizeBytes: zod.z.number().int(),
});
const localArtifactFileListSchema = zod.z.object({
    files: zod.z.array(localArtifactFileEntrySchema),
    usedIgnoreFile: zod.z.string().nullable(),
});

const downloadProgressUpdateSchema = zod.z.object({
    downloadedBytes: zod.z.number().int(),
    totalBytes: zod.z.number().int(),
    speedBytesPerSecond: zod.z.number(),
});

const modelSearchResultDownloadOptionFitEstimationSchema = zod.z.enum([
    "fullGPUOffload",
    "partialGPUOffload",
    "fitWithoutGPU",
    "willNotFit",
]);
const modelSearchResultDownloadOptionDataSchema = zod.z.object({
    quantization: zod.z.string().optional(),
    name: zod.z.string(),
    sizeBytes: zod.z.number().int(),
    fitEstimation: modelSearchResultDownloadOptionFitEstimationSchema,
    recommended: zod.z.boolean().optional(),
    downloadIdentifier: zod.z.string(),
    indexedModelIdentifier: zod.z.string(),
});
const modelSearchResultIdentifierSchema = zod.z.discriminatedUnion("type", [
    zod.z.object({
        type: zod.z.literal("catalog"),
        identifier: zod.z.string(),
    }),
    zod.z.object({
        type: zod.z.literal("hf"),
        identifier: zod.z.string(),
    }),
]);
const modelSearchResultEntryDataSchema = zod.z.object({
    name: zod.z.string(),
    identifier: modelSearchResultIdentifierSchema,
    exact: zod.z.boolean().optional(),
    staffPick: zod.z.boolean().optional(),
});
const modelSearchOptsSchema = zod.z.object({
    searchTerm: zod.z.string().optional(),
    limit: zod.z.number().int().positive().max(25).optional(),
    compatibilityTypes: zod.z.array(modelCompatibilityTypeSchema).optional(),
});

const internalRetrievalResultEntrySchema = zod.z.object({
    content: zod.z.string(),
    score: zod.z.number(),
    sourceIndex: zod.z.number().int(),
    pageNumber: zod.z.union([zod.z.number().int(), zod.z.tuple([zod.z.number().int(), zod.z.number().int()])]).optional(),
    lineNumber: zod.z.union([zod.z.number().int(), zod.z.tuple([zod.z.number().int(), zod.z.number().int()])]).optional(),
});
const internalRetrievalResultSchema = zod.z.object({
    entries: zod.z.array(internalRetrievalResultEntrySchema),
});

zod.z.object({
    content: zod.z.string(),
    score: zod.z.number(),
    citation: citationSourceSchema,
});

const retrievalChunkingMethodSchema = zod.z.discriminatedUnion("type", [
    zod.z.object({
        type: zod.z.literal("recursive-v1"),
        chunkSize: zod.z.number().int(),
        chunkOverlap: zod.z.number().int(),
    }),
]);

const retrievalFileProcessingStepSchema = zod.z.enum(["loading", "chunking", "embedding"]);

const acceleratorTypeSchema = zod.z.enum(["unknown", "integratedGpu", "dedicatedGpu"]);
const acceleratorSchema = zod.z.object({
    name: zod.z.string(),
    deviceId: zod.z.number().int(),
    totalMemoryBytes: zod.z.number().int(),
    type: acceleratorTypeSchema,
});
zod.z.object({
    key: zod.z.string(),
    name: zod.z.string(),
    accelerators: zod.z.array(acceleratorSchema),
});

const serializedKVConfigSchematicsFieldSchema = zod.z.object({
    shortKey: zod.z.string(),
    fullKey: zod.z.string(),
    typeKey: zod.z.string(),
    typeParams: jsonSerializableSchema,
    defaultValue: jsonSerializableSchema,
});
const serializedKVConfigSchematicsSchema = zod.z.object({
    fields: zod.z.array(serializedKVConfigSchematicsFieldSchema),
    extensionPrefixes: zod.z.array(zod.z.string()).optional(),
});
zod.z.object({
    fullKey: zod.z.string(),
    error: jsonSerializableSchema,
});

const booleanOrMixedSchema = zod.z.union([
    zod.z.literal(true),
    zod.z.literal(false),
    zod.z.literal("mixed"),
]);
const virtualModelDefinitionMetadataOverridesSchema = zod.z.object({
    domain: modelDomainTypeSchema.optional(),
    architectures: zod.z.array(zod.z.string()).optional(),
    compatibilityTypes: zod.z.array(modelCompatibilityTypeSchema).optional(),
    paramsStrings: zod.z.array(zod.z.string()).optional(),
    minMemoryUsageBytes: zod.z.number().optional(),
    contextLengths: zod.z.array(zod.z.number()).optional(),
    trainedForToolUse: booleanOrMixedSchema.optional(),
    vision: booleanOrMixedSchema.optional(),
    reasoning: booleanOrMixedSchema.optional(),
    fim: booleanOrMixedSchema.optional(),
});
const virtualModelDefinitionConcreteModelBaseSchema = zod.z.object({
    key: zod.z.string(),
    sources: zod.z.array(modelDownloadSourceSchema),
});
const virtualModelCustomFieldSetJinjaVariableEffectSchema = zod.z.object({
    type: zod.z.literal("setJinjaVariable"),
    variable: zod.z.string(),
});
const virtualModelCustomFieldPrependSystemPromptEffectSchema = zod.z.object({
    type: zod.z.literal("prependSystemPrompt"),
    content: zod.z.string(),
});
const virtualModelCustomFieldAppendSystemPromptEffectSchema = zod.z.object({
    type: zod.z.literal("appendSystemPrompt"),
    content: zod.z.string(),
});
const virtualModelCustomFieldDefinitionBaseSchema = zod.z.object({
    key: zod.z.string(),
    displayName: zod.z.string(),
    description: zod.z.string(),
});
const virtualModelBooleanCustomFieldDefinitionSchema = virtualModelCustomFieldDefinitionBaseSchema.extend({
    type: zod.z.literal("boolean"),
    defaultValue: zod.z.boolean(),
    effects: zod.z.array(zod.z.discriminatedUnion("type", [
        virtualModelCustomFieldSetJinjaVariableEffectSchema,
        virtualModelCustomFieldPrependSystemPromptEffectSchema,
        virtualModelCustomFieldAppendSystemPromptEffectSchema,
    ])),
});
const virtualModelStringCustomFieldDefinitionSchema = virtualModelCustomFieldDefinitionBaseSchema.extend({
    type: zod.z.literal("string"),
    defaultValue: zod.z.string(),
    effects: zod.z.array(zod.z.discriminatedUnion("type", [virtualModelCustomFieldSetJinjaVariableEffectSchema])),
});
const virtualModelSelectCustomFieldDefinitionSchema = virtualModelCustomFieldDefinitionBaseSchema.extend({
    type: zod.z.literal("select"),
    options: zod.z.array(zod.z.object({
        label: zod.z.string(),
        value: zod.z.string(),
    })),
    defaultValue: zod.z.string(),
    effects: zod.z.array(zod.z.discriminatedUnion("type", [virtualModelCustomFieldSetJinjaVariableEffectSchema])),
});
const virtualModelCustomFieldDefinitionSchema = zod.z.discriminatedUnion("type", [
    virtualModelBooleanCustomFieldDefinitionSchema,
    virtualModelStringCustomFieldDefinitionSchema,
    virtualModelSelectCustomFieldDefinitionSchema,
]);
const virtualModelConditionEqualsSchema = zod.z.object({
    type: zod.z.literal("equals"),
    key: zod.z.string(),
    value: jsonSerializableSchema,
});
const virtualModelConditionSchema = zod.z.discriminatedUnion("type", [
    virtualModelConditionEqualsSchema,
]);
const virtualModelSuggestionSchema = zod.z.object({
    message: zod.z.string(),
    conditions: zod.z.array(virtualModelConditionSchema),
    fields: zod.z.array(kvConfigFieldSchema).optional(),
});
zod.z.object({
    model: zod.z.string().regex(/^[^/]+\/[^/]+$/),
    base: zod.z.union([zod.z.string(), zod.z.array(virtualModelDefinitionConcreteModelBaseSchema)]),
    tags: zod.z.array(zod.z.string().max(100)).optional(),
    config: zod.z
        .object({
        load: kvConfigSchema.optional(),
        operation: kvConfigSchema.optional(),
    })
        .optional(),
    metadataOverrides: virtualModelDefinitionMetadataOverridesSchema.optional(),
    customFields: zod.z.array(virtualModelCustomFieldDefinitionSchema).optional(),
    suggestions: zod.z.array(virtualModelSuggestionSchema).optional(),
});

const logLevelSchema = zod.z.enum(["debug", "info", "warn", "error"]);

/**
 * Call a user provided callback and log any errors that occur. This prevents the error from
 * crashing the application.
 */
function safeCallCallback(logger, name, callback, args) {
    if (callback === undefined) {
        return;
    }
    try {
        const maybePromise = callback(...args);
        if (typeof maybePromise === "object" && typeof maybePromise.catch === "function") {
            maybePromise.catch((error) => {
                logger.error(`Error in the ${name} callback (triggered asynchronously):`, error);
            });
        }
    }
    catch (error) {
        logger.error(`Error in the ${name} callback:`, error);
    }
}

function isSimpleLogger(logger) {
    return logger?.isSimpleLogger === true;
}
const defaultInfoPrefix = chalk.greenBright("I");
const defaultWarnPrefix = chalk.yellowBright("W");
const defaultErrorPrefix = chalk.redBright("E");
const defaultDebugPrefix = chalk.blueBright("D");
class SimpleLogger {
    constructor(prefixText = "", parentLogger = console, { useLogLevelPrefixes, infoPrefix, warnPrefix, errorPrefix, debugPrefix, } = {}) {
        this.isSimpleLogger = true;
        this.infoPrefix = [];
        this.warnPrefix = [];
        this.errorPrefix = [];
        this.debugPrefix = [];
        if (isSimpleLogger(parentLogger)) {
            useLogLevelPrefixes = useLogLevelPrefixes ?? parentLogger.opts.useLogLevelPrefixes;
            infoPrefix = infoPrefix === undefined ? parentLogger.opts.infoPrefix : infoPrefix;
            warnPrefix = warnPrefix === undefined ? parentLogger.opts.warnPrefix : warnPrefix;
            errorPrefix = errorPrefix === undefined ? parentLogger.opts.errorPrefix : errorPrefix;
            debugPrefix = debugPrefix === undefined ? parentLogger.opts.debugPrefix : debugPrefix;
            if (prefixText === "") {
                this.innerPrefix = parentLogger.innerPrefix;
                this.fullPrefix = parentLogger.fullPrefix;
            }
            else {
                if (parentLogger.fullPrefix === "") {
                    this.innerPrefix = prefixText;
                }
                else {
                    this.innerPrefix = `${parentLogger.innerPrefix}][${prefixText}`;
                }
                this.fullPrefix = chalk.whiteBright(`[${this.innerPrefix}]`);
            }
            this.parentLogger = parentLogger.parentLogger;
        }
        else {
            useLogLevelPrefixes = useLogLevelPrefixes ?? false;
            infoPrefix = infoPrefix === undefined ? defaultInfoPrefix : infoPrefix;
            warnPrefix = warnPrefix === undefined ? defaultWarnPrefix : warnPrefix;
            errorPrefix = errorPrefix === undefined ? defaultErrorPrefix : errorPrefix;
            debugPrefix = debugPrefix === undefined ? defaultDebugPrefix : debugPrefix;
            if (prefixText === "") {
                this.innerPrefix = "";
                this.fullPrefix = "";
            }
            else {
                this.innerPrefix = prefixText;
                this.fullPrefix = chalk.whiteBright(`[${this.innerPrefix}]`);
            }
            this.parentLogger = parentLogger;
        }
        if (useLogLevelPrefixes) {
            if (infoPrefix !== null) {
                this.infoPrefix.push(infoPrefix);
            }
            if (warnPrefix !== null) {
                this.warnPrefix.push(warnPrefix);
            }
            if (errorPrefix !== null) {
                this.errorPrefix.push(errorPrefix);
            }
            if (debugPrefix !== null) {
                this.debugPrefix.push(debugPrefix);
            }
        }
        if (this.fullPrefix !== "") {
            this.infoPrefix.push(this.fullPrefix);
            this.warnPrefix.push(this.fullPrefix);
            this.errorPrefix.push(this.fullPrefix);
            this.debugPrefix.push(this.fullPrefix);
        }
        this.opts = {
            useLogLevelPrefixes,
            infoPrefix,
            warnPrefix,
            errorPrefix,
            debugPrefix,
        };
    }
    subclass(prefixText) {
        return new SimpleLogger(`${this.innerPrefix}:${prefixText}`, this.parentLogger);
    }
    info(...messages) {
        this.parentLogger.info(...this.infoPrefix, ...messages);
    }
    infoText(strings, ...values) {
        this.info(text(strings, ...values));
    }
    infoWithoutPrefix(...messages) {
        this.parentLogger.info(...messages);
    }
    error(...messages) {
        this.parentLogger.error(...this.errorPrefix, ...messages);
    }
    errorText(strings, ...values) {
        this.error(text(strings, ...values));
    }
    errorWithoutPrefix(...messages) {
        this.parentLogger.error(...messages);
    }
    warn(...messages) {
        this.parentLogger.warn(...this.warnPrefix, ...messages);
    }
    warnText(strings, ...values) {
        this.warn(text(strings, ...values));
    }
    warnWithoutPrefix(...messages) {
        this.parentLogger.warn(...messages);
    }
    debug(...messages) {
        this.parentLogger.debug(...this.debugPrefix, ...messages);
    }
    debugText(strings, ...values) {
        this.debug(text(strings, ...values));
    }
    debugWithoutPrefix(...messages) {
        this.parentLogger.debug(...messages);
    }
    throw(message) {
        throw new Error(`${this.fullPrefix} ${message}`);
    }
    logAtLevel(level, ...messages) {
        switch (level) {
            case "debug":
                this.debug(...messages);
                break;
            case "info":
                this.info(...messages);
                break;
            case "warn":
                this.warn(...messages);
                break;
            case "error":
                this.error(...messages);
                break;
        }
    }
    static fromMultiple(loggers, opts) {
        return new SimpleLogger("", {
            debug: (...messages) => {
                for (const logger of loggers) {
                    logger.debug(...messages);
                }
            },
            info: (...messages) => {
                for (const logger of loggers) {
                    logger.info(...messages);
                }
            },
            warn: (...messages) => {
                for (const logger of loggers) {
                    logger.warn(...messages);
                }
            },
            error: (...messages) => {
                for (const logger of loggers) {
                    logger.error(...messages);
                }
            },
        }, {
            ...opts,
            useLogLevelPrefixes: false,
        });
    }
}

var _a;
const finished = Symbol("finished");
/**
 * A StreamablePromise is a promise-like that is also async iterable. This means you can use it as a
 * promise (awaiting it, using `.then`, `.catch`, etc.), and you can also use it as an async
 * iterable (using `for await`).
 *
 * Notably, as much as it implements the async iterable interface, it is not a traditional iterable,
 * as it internally maintains a buffer and new values are pushed into the buffer by the producer, as
 * oppose to being pulled by the consumer.
 *
 * The async iterable interface is used instead of the Node.js object stream because streams are too
 * clunky to use, and the `for await` syntax is much more ergonomic for most people.
 *
 * If any iterator is created for this instance, an empty rejection handler will be attached to the
 * promise to prevent unhandled rejection warnings.
 *
 * This class is provided as an abstract class and is meant to be extended. Crucially, the `collect`
 * method must be implemented, which will be called to convert an array of values into the final
 * resolved value of the promise.
 *
 * In addition, the constructor of the subclass should be marked as private, and a static method
 * that exposes the constructor, the `finished` method, and the `push` method should be provided.
 *
 * @typeParam TFragment - The type of the individual fragments that are pushed into the buffer.
 * @typeParam TFinal - The type of the final resolved value of the promise.
 * @public
 */
class StreamablePromise {
    /**
     * Called by the producer when it has finished producing values. If an error is provided, the
     * promise will be rejected with that error. If no error is provided, the promise will be resolved
     * with the final value.
     *
     * This method should be exposed in the static constructor of the subclass.
     *
     * @param error - The error to reject the promise with, if any.
     */
    finished(error) {
        if (this.status !== "pending") {
            throw new Error("`finished` called while not pending");
        }
        if (error === undefined) {
            this.status = "resolved";
            this.nextFragmentPromiseBundle?.resolve(finished);
            this.resolveFinal(this.collect(this.buffer));
        }
        else {
            this.status = "rejected";
            this.nextFragmentPromiseBundle?.reject(error);
            this.rejectFinal(error);
        }
    }
    /**
     * Called by the producer to push a new fragment into the buffer. This method should be exposed in
     * the static constructor of the subclass.
     *
     * This method should be exposed in the static constructor of the subclass.
     *
     * @param fragment - The fragment to push into the buffer.
     */
    push(fragment) {
        if (this.status !== "pending") {
            throw new Error("`push` called while not pending");
        }
        this.buffer.push(fragment);
        this.nextFragmentPromiseBundle?.resolve(fragment);
        this.nextFragmentPromiseBundle = null;
    }
    constructor() {
        this.status = "pending";
        this.buffer = [];
        this.nextFragmentPromiseBundle = null;
        /**
         * If there has ever been any iterators created for this instance. Once any iterator is created,
         * a reject handler will be attached to the promise to prevent unhandled rejection warnings, as
         * the errors will be handled by the iterator.
         *
         * The purpose of this variable is to prevent registering the reject handler more than once.
         */
        this.hasIterator = false;
        this[_a] = "StreamablePromise";
        const { promise, resolve, reject } = makePromise();
        this.promiseFinal = promise;
        this.resolveFinal = resolve;
        this.rejectFinal = reject;
    }
    then(onfulfilled, onrejected) {
        return this.promiseFinal.then(onfulfilled, onrejected);
    }
    catch(onrejected) {
        return this.promiseFinal.catch(onrejected);
    }
    finally(onfinally) {
        return this.promiseFinal.finally(onfinally);
    }
    /**
     * If nextFragmentPromiseBundle exists, it is returned. Otherwise, a new one is created and
     * returned.
     */
    obtainNextFragmentPromiseBundle() {
        if (this.nextFragmentPromiseBundle === null) {
            this.nextFragmentPromiseBundle = makePromise();
        }
        return this.nextFragmentPromiseBundle;
    }
    async *[(_a = Symbol.toStringTag, Symbol.asyncIterator)]() {
        if (!this.hasIterator) {
            this.promiseFinal.catch(() => { }); // Prevent unhandled rejection warning
            this.hasIterator = true;
        }
        let i = 0;
        while (i < this.buffer.length || this.status === "pending") {
            if (i < this.buffer.length) {
                yield this.buffer[i];
                i++;
            }
            else {
                const nextFragmentPromiseBundle = this.obtainNextFragmentPromiseBundle();
                const nextFragment = await nextFragmentPromiseBundle.promise;
                if (nextFragment === finished) {
                    // Make sure the promise is resolved before breaking the loop.
                    break;
                }
                yield nextFragment;
                i++;
            }
        }
        await this.promiseFinal;
        // Wait for one more microtask to ensure that the promise is resolved before terminating the
        // loop. This ensures that the by the time async loop is terminated, the onMessage handler is
        // already triggered.
        await Promise.resolve();
    }
}

class Validator {
    constructor({ attachStack } = {}) {
        this.attachStack = attachStack ?? true;
    }
    /**
     * Pretty-prints a Zod error.
     *
     * @param rootObjectName - The name of the object being validated (used for error messages)
     * @param error - The Zod error to pretty-print
     *
     * @returns The pretty-printed error in a string
     */
    static prettyPrintZod(rootObjectName, error) {
        return error.errors
            .map(e => {
            if (e.path.length === 0) {
                return `- ${chalk.redBright(rootObjectName)}: ${e.message}`;
            }
            const path = chalk.red(`.${e.path.join(".")}`);
            return `- ${chalk.redBright(rootObjectName)}${path}: ${e.message}`;
        })
            .join("\n");
    }
    /**
     * Validates a value against a schema and throws an error if it's invalid.
     *
     * @param lead - The start of the error message (used for error messages)
     * @param rootObjectName - The name of the object being validated (used for error messages)
     * @param schema - The schema to validate against
     * @param value - The value to validate
     *
     * @returns The validated value
     * @throws An error if the value is invalid
     */
    validateOrThrow(lead, rootObjectName, schema, value, stack) {
        const result = schema.safeParse(value);
        if (result.success) {
            return result.data;
        }
        else {
            throw makePrettyError(`${lead}\n\n${Validator.prettyPrintZod(rootObjectName, result.error)}`, this.attachStack ? stack : undefined);
        }
    }
    /**
     * Validates multiple values against multiple schemas and throws an error if any of them are
     * invalid. All values are validated before any errors are thrown. This is useful when you want to
     * validate multiple values at once and want to see all the errors at once.
     *
     * @param leadProducer - The function to produce the start of the error message (used for error).
     * It is called with a set of indices of the invalid values.
     * @param rootObjectNames - The names of the objects being validated (used for error messages)
     * @param schemas - The schemas to validate against
     * @param values - The values to validate
     *
     * @returns The validated values
     * @throws An error if any of the values are invalid
     */
    validateMultipleOrThrow(leadProducer, rootObjectNames, schemas, values, stack) {
        const results = schemas.map((schema, index) => schema.safeParse(values[index]));
        const errors = results
            .map((result, index) => ({ result, index, rootObjectName: rootObjectNames[index] }))
            .filter(({ result }) => !result.success)
            .map(({ result, rootObjectName, index }) => ({
            error: result.error,
            rootObjectName,
            index,
        }));
        if (errors.length === 0) {
            return results.map(result => result.data);
        }
        else {
            const erroredValues = new Set(errors.map(({ index }) => index));
            const lead = leadProducer(erroredValues);
            throw makePrettyError(`${lead}\n\n${errors
                .map(({ error, rootObjectName }) => Validator.prettyPrintZod(rootObjectName, error))
                .join("\n")}`, this.attachStack ? stack : undefined);
        }
    }
    /**
     * Validates a value against a schema and throws an error if it's invalid. This is a convenience
     * function for validating one single method parameter.
     *
     * @param className - The name of the class containing the method (used for error messages)
     * @param methodName - The name of the method (used for error messages)
     * @param paramName - The name of the parameter being validated (used for error messages)
     * @param schema - The schema to validate against
     * @param value - The value to validate
     *
     * @returns The validated value
     * @throws An error if the value is invalid
     */
    validateMethodParamOrThrow(className, methodName, paramName, schema, value, stack) {
        const functionCall = chalk.yellowBright(text `
    ${className}.${methodName}(${chalk.redBright(paramName)})
  `);
        return this.validateOrThrow(`Invalid parameter(s) for ${functionCall}:`, paramName, schema, value, stack);
    }
    /**
     * Validates multiple values against multiple schemas and throws an error if any of them are
     * invalid. This is a convenience function for validating multiple method parameters.
     *
     * @param className - The name of the class containing the method (used for error messages)
     * @param methodName - The name of the method (used for error messages)
     * @param paramNames - The names of the parameters being validated (used for error messages)
     * @param schemas - The schemas to validate against
     * @param values - The values to validate
     *
     * @returns The validated values
     * @throws An error if any of the values are invalid
     */
    validateMethodParamsOrThrow(className, methodName, paramNames, schemas, values, stack) {
        return this.validateMultipleOrThrow(erroredValues => {
            const coloredParamNames = paramNames.map((name, index) => erroredValues.has(index) ? chalk.redBright(name) : name);
            const functionCall = chalk.yellowBright(text `
        ${className}.${methodName}(${coloredParamNames.join(", ")})
      `);
            return `Invalid parameter(s) for ${functionCall}:`;
        }, paramNames, schemas, values, stack);
    }
    /**
     * Validates a value against a schema and throws an error if it's invalid. This is a convenience
     * function for validating one single constructor parameter.
     *
     * @param className - The name of the class (used for error messages)
     * @param paramName - The name of the parameter being validated (used for error messages)
     * @param schema - The schema to validate against
     * @param value - The value to validate
     *
     * @returns The validated value
     * @throws An error if the value is invalid
     */
    validateConstructorParamOrThrow(className, paramName, schema, value, stack) {
        const functionCall = chalk.yellowBright(text `
    ${className}(${chalk.redBright(paramName)})
  `);
        return this.validateOrThrow(`Invalid parameter(s) when constructing ${functionCall}`, paramName, schema, value, stack);
    }
    /**
     * Validates multiple values against multiple schemas and throws an error if any of them are
     * invalid. This is a convenience function for validating multiple constructor parameters.
     *
     * @param className - The name of the class (used for error messages)
     * @param paramNames - The names of the parameters being validated (used for error messages)
     *
     * @param schemas - The schemas to validate against
     * @param values - The values to validate
     */
    validateConstructorParamsOrThrow(className, paramNames, schemas, values, stack) {
        return this.validateMultipleOrThrow(erroredValues => {
            const coloredParamNames = paramNames.map((name, index) => erroredValues.has(index) ? chalk.redBright(name) : name);
            const functionCall = chalk.yellowBright(text `
        ${className}(${coloredParamNames.join(", ")})
      `);
            return `Invalid parameter(s) when constructing ${functionCall}:`;
        }, paramNames, schemas, values, stack);
    }
}
const sharedValidator = new Validator();

/**
 * Represents a file. Currently, the file can be either in the local file system or base64 encoded.
 *
 * @public
 */
class FileHandle {
    /**
     * @deprecated Direct construction is not recommended. Please use the `prepareFile` API instead
     */
    constructor(filesNamespace, identifier, type, sizeBytes, 
    /**
     * Original file name
     */
    name) {
        this.filesNamespace = filesNamespace;
        this.identifier = identifier;
        this.type = type;
        this.sizeBytes = sizeBytes;
        this.name = name;
        this.parsedIdentifier = parseFileIdentifier(identifier);
    }
    /**
     * Gets the absolute file path of this file.
     */
    async getFilePath() {
        switch (this.parsedIdentifier.type) {
            case "local": {
                return (await this.filesNamespace.getLocalFileAbsolutePath(this.parsedIdentifier.fileName))
                    .path;
            }
            case "base64": {
                throw new Error("Not implemented. Please open an issue on GitHub if you encountered this error.");
            }
            default: {
                const _exhaustiveCheck = this.parsedIdentifier;
                throw new Error(`Unexpected file identifier type: ${JSON.stringify(_exhaustiveCheck)}`);
            }
        }
    }
    isImage() {
        return this.type === "image";
    }
}

const chatMessageInputSchema = zod.z.object({
    role: zod.z.enum(["user", "assistant", "system"]).optional(),
    content: zod.z.string().optional(),
    images: zod.z.array(zod.z.instanceof(FileHandle)).optional(),
});
const chatHistoryInputSchema = zod.z.array(chatMessageInputSchema);
/**
 * Given a `ChatMessageInput` or `ChatMessageData`, returns true if the input is a
 * `ChatMessageInput`.
 */
function isChatMessageInputAsOpposeToChatMessageData(chatMessageInput) {
    return !Array.isArray(chatMessageInput.content);
}
function isChatMessageInputAsOpposeToChatHistoryData(chatMessageInput) {
    return !("messages" in chatMessageInput);
}
function chatMessageInputToChatMessageData(chatMessageInput) {
    const { role, content, images } = chatMessageInput;
    const parts = [];
    if (images === undefined || images.length === 0) {
        if (content === undefined) {
            // If both content and file are undefined, let's just create an empty part.
            parts.push({
                type: "text",
                text: "",
            });
        }
    }
    else {
        for (const file of images) {
            parts.push({
                type: "file",
                identifier: file.identifier,
                name: file.name,
                fileType: file.type,
                sizeBytes: file.sizeBytes,
            });
        }
    }
    if (content !== undefined) {
        parts.push({
            type: "text",
            text: content,
        });
    }
    return {
        role: role ?? "user",
        content: parts,
    };
}

/**
 * Represents a chat history.
 *
 * @public
 */
class Chat extends MaybeMutable {
    getClassName() {
        return "Chat";
    }
    create(data, mutable) {
        return new Chat(data, mutable);
    }
    cloneData(data) {
        return chatHistoryDataSchema.parse(data); // Using zod to clone the data
    }
    /**
     * Don't use this constructor directly.
     *
     * - To create an empty chat history, use `Chat.empty()`.
     * - To create a chat history with existing data, use `Chat.from()`.
     */
    constructor(data, mutable) {
        super(data, mutable);
    }
    /**
     * Creates an empty mutable chat history.
     */
    static empty() {
        return new Chat({ messages: [] }, true);
    }
    /**
     * Quickly create a mutable chat history with something that can be converted to a chat history.
     *
     * The created chat history will be a mutable copy of the input.
     *
     * @example
     * ```ts
     * const history = Chat.from([
     *   { role: "user", content: "Hello" },
     *   { role: "assistant", content: "Hi!" },
     *   { role: "user", content: "What is your name?" },
     * ]);
     * ```
     */
    static from(initializer) {
        const stack = getCurrentStack(1);
        sharedValidator.validateMethodParamOrThrow("Chat", "from", "initializer", chatHistoryLikeSchema, initializer, stack);
        if (initializer instanceof Chat) {
            // Chat
            return initializer.asMutableCopy();
        }
        if (typeof initializer === "string") {
            const chatHistory = Chat.empty();
            chatHistory.append("user", initializer);
            return chatHistory;
        }
        if (Array.isArray(initializer)) {
            // ChatInput
            return new Chat({ messages: initializer.map(chatMessageInputToChatMessageData) }, true);
        }
        if (isChatMessageInputAsOpposeToChatHistoryData(initializer)) {
            // ChatMessageInput
            return new Chat({ messages: [chatMessageInputToChatMessageData(initializer)] }, true);
        }
        else {
            // ChatHistoryData
            return new Chat(initializer, false).asMutableCopy();
        }
    }
    /**
     * Creates a chat history with raw data. This method is intended for internal use only.
     *
     * If mutable is set to false, you MUST ensure that the data is not mutated.
     *
     * @internal
     */
    static createRaw(data, mutable) {
        return new Chat(data, mutable);
    }
    /**
     * Gets the raw data of this message. This method is intended for internal use only.
     *
     * If mutable is set to false, you MUST ensure that the data is not mutated.
     *
     * @internal
     */
    getRaw() {
        return this.data;
    }
    append(...args) {
        this.guardMutable();
        if (args.length === 1) {
            const [chatMessageLike] = args;
            const chatMessage = ChatMessage.from(chatMessageLike);
            const messageMutable = accessMaybeMutableInternals(chatMessage)._internalToMutable();
            this.data.messages.push(accessMaybeMutableInternals(messageMutable)._internalGetData());
        }
        else {
            const [role, content, opts = {}] = args;
            if (role === "user" || role === "system" || role === "assistant") {
                const parts = [
                    { type: "text", text: content },
                ];
                if (opts.images !== undefined) {
                    for (const image of opts.images) {
                        parts.push({
                            type: "file",
                            name: image.name,
                            identifier: image.identifier,
                            sizeBytes: image.sizeBytes,
                            fileType: image.type,
                        });
                    }
                }
                this.data.messages.push({ role, content: parts });
            }
            else {
                throw new Error(text `
          Unsupported role for append() API with [role, content] parameters: ${role}.
          Supported roles are 'user', 'system', and 'assistant'.
        `);
            }
        }
    }
    withAppended(...args) {
        const copy = this.asMutableCopy();
        copy.append(...args);
        return copy;
    }
    /**
     * Get the number of messages in the history.
     */
    getLength() {
        return this.data.messages.length;
    }
    /**
     * Get the number of messages in the history.
     */
    get length() {
        return this.getLength();
    }
    /**
     * Remove the last message from the history. If the history is empty, this method will throw.
     */
    pop() {
        this.guardMutable();
        if (this.data.messages.length === 0) {
            throw new Error("Tried to pop from an empty history.");
        }
        const popped = this.data.messages.pop();
        return ChatMessage.createRaw(popped, true);
    }
    /**
     * Gets all files contained in this history.
     *
     * @param client - LMStudio client
     */
    getAllFiles(client) {
        return this.data.messages
            .flatMap(message => message.content.filter(part => part.type === "file"))
            .map(part => new FileHandle(client.files, part.identifier, part.fileType, part.sizeBytes, part.name));
    }
    /**
     * Allows iterating over the files in the history.
     */
    *files(client) {
        for (const message of this.data.messages) {
            for (const part of message.content) {
                if (part.type === "file") {
                    yield new FileHandle(client.files, part.identifier, part.fileType, part.sizeBytes, part.name);
                }
            }
        }
    }
    /**
     * Returns true if this history contains any files.
     */
    hasFiles() {
        return this.data.messages.some(message => message.content.some(part => part.type === "file"));
    }
    /**
     * Gets the message at the given index. If the index is negative, it will be counted from the end.
     *
     * If the index is out of bounds, this method will throw as oppose to returning undefined. This is
     * to help catch bugs early.
     */
    at(index) {
        let actualIndex = index;
        if (index < 0) {
            actualIndex = this.data.messages.length + index;
        }
        if (actualIndex < 0 || actualIndex >= this.data.messages.length) {
            throw new Error(text `
        Tried to access the message at index ${index}, but the history only has
        ${this.data.messages.length} messages.
      `);
        }
        return ChatMessage.createRaw(this.data.messages[actualIndex], this.mutable);
    }
    /**
     * Get all the messages in the history as an array of ChatMessage objects.
     */
    getMessagesArray() {
        return this.data.messages.map(message => ChatMessage.createRaw(message, this.mutable));
    }
    /**
     * Maps over the messages in the history and returns an array of the results.
     */
    map(mapper) {
        return this.getMessagesArray().map(mapper);
    }
    /**
     * Maps over the messages in the history and returns a flattened array of the results.
     *
     * This is similar to `Array.prototype.flatMap`, but it works with ChatMessage objects.
     */
    flatMap(mapper) {
        return this.getMessagesArray().flatMap(mapper);
    }
    /**
     * Allows iterating over the messages in the history.
     */
    *[Symbol.iterator]() {
        for (const message of this.data.messages) {
            yield ChatMessage.createRaw(message, this.mutable);
        }
    }
    /**
     * Given a predicate, the predicate is called for each file in the history.
     *
     * - If the predicate returns true, the file is removed from the history and is collected into the
     *   returned array.
     * - If the predicate returns false, the file is kept in the history.
     *
     * This method is useful if you are implementing a promptPreprocessor that needs to convert certain
     * types of files.
     *
     * If the predicate needs to be async, use the {@link Chat#consumeFilesAsync} method.
     *
     * @param client - LMStudio client
     * @param predicate - The predicate to call for each file.
     * @returns The files that were consumed.
     */
    consumeFiles(client, predicate) {
        this.guardMutable();
        const consumedFiles = [];
        for (const message of this.data.messages) {
            consumedFiles.push(...ChatMessage.createRaw(message, true).consumeFiles(client, predicate));
        }
        return consumedFiles;
    }
    /**
     * Given an async predicate, the predicate is called for each file in the history.
     *
     * - If the predicate returns true, the file is removed from the history and is collected into the
     *  returned array.
     * - If the predicate returns false, the file is kept in the history.
     *
     * This method is useful if you are implementing a promptPreprocessor that needs to convert certain
     * types of files.
     *
     * If you need a synchronous version, use the {@link Chat#consumeFiles} method.
     *
     * @param client - LMStudio client
     * @param predicate - The predicate to call for each file.
     * @returns The files that were consumed.
     */
    async consumeFilesAsync(client, predicate) {
        this.guardMutable();
        const consumedFiles = [];
        for (const message of this.data.messages) {
            consumedFiles.push(...(await ChatMessage.createRaw(message, true).consumeFilesAsync(client, predicate)));
        }
        return consumedFiles;
    }
    getSystemPrompt() {
        return this.data.messages
            .filter(message => message.role === "system")
            .map(message => message.content
            .filter(part => part.type === "text")
            .map(part => part.text)
            .join(" "))
            .join("\n\n");
    }
    replaceSystemPrompt(content) {
        this.guardMutable();
        this.data.messages = this.data.messages.filter(message => message.role !== "system");
        this.data.messages.unshift({ role: "system", content: [{ type: "text", text: content }] });
    }
    filterInPlace(predicate) {
        this.guardMutable();
        this.data.messages = this.data.messages.filter(message => predicate(ChatMessage.createRaw(message, true)));
    }
    toString() {
        return ("Chat {\n" +
            this.data.messages
                .map(message => {
                const messageString = ChatMessage.createRaw(message, false).toString();
                return messageString
                    .split("\n")
                    .map(line => "  " + line)
                    .join("\n");
            })
                .join("\n") +
            "\n}");
    }
}
const chatHistoryLikeSchema = zod.z.union([
    zod.z.instanceof(Chat),
    chatHistoryDataSchema,
    zod.z.string(),
    chatHistoryInputSchema,
    chatMessageInputSchema,
]);
/**
 * Represents a single message in the history.
 *
 * @public
 */
class ChatMessage extends MaybeMutable {
    getClassName() {
        return "ChatMessage";
    }
    create(data, mutable) {
        return new ChatMessage(data, mutable);
    }
    cloneData(data) {
        return chatMessageDataSchema.parse(data); // Using zod to clone the data
    }
    constructor(data, mutable) {
        super(data, mutable);
    }
    /**
     * Create a mutable text only message.
     */
    static create(role, content) {
        return new ChatMessage(chatMessageDataSchema.parse({
            role,
            content: [{ type: "text", text: content }],
        }), true);
    }
    /**
     * Quickly create a mutable message with something that can be converted to a message.
     */
    static from(initializer) {
        const stack = getCurrentStack(1);
        sharedValidator.validateMethodParamOrThrow("ChatMessage", "from", "initializer", chatMessageLikeSchema, initializer, stack);
        if (initializer instanceof ChatMessage) {
            // ChatMessage
            return initializer.asMutableCopy();
        }
        if (typeof initializer === "string") {
            return new ChatMessage(chatMessageDataSchema.parse({
                role: "user",
                content: [{ type: "text", text: initializer }],
            }), true);
        }
        if (isChatMessageInputAsOpposeToChatMessageData(initializer)) {
            // ChatMessageData
            return new ChatMessage(chatMessageInputToChatMessageData(initializer), true);
        }
        else {
            // ChatMessageInput
            return new ChatMessage(initializer, true);
        }
    }
    /**
     * Creates a chat history with raw data. This method is intended for internal use only.
     *
     * If mutable is set to false, you MUST ensure that the data is not mutated.
     *
     * @internal
     */
    static createRaw(data, mutable) {
        return new ChatMessage(data, mutable);
    }
    /**
     * Gets the raw data of this message. This method is intended for internal use only.
     *
     * If mutable is set to false, you MUST ensure that the data is not mutated.
     *
     * @internal
     */
    getRaw() {
        return this.data;
    }
    getRole() {
        return this.data.role;
    }
    setRole(role) {
        this.guardMutable();
        this.data.role = role;
    }
    getFileParts() {
        return this.data.content.filter(part => part.type === "file");
    }
    /**
     * Gets all text contained in this message.
     */
    getText() {
        return this.data.content
            .filter(part => part.type === "text")
            .map(part => part.text)
            .join(" ");
    }
    /**
     * Get all tool call results within this message.
     */
    getToolCallResults() {
        return this.data.content
            .filter(part => part.type === "toolCallResult")
            .map(part => ({
            content: part.content,
            toolCallId: part.toolCallId,
        }));
    }
    /**
     * Gets all file parts contained in this message.
     */
    getToolCallRequests() {
        return this.data.content
            .filter(part => part.type === "toolCallRequest")
            .map(part => part.toolCallRequest);
    }
    /**
     * Gets all files contained in this message.
     *
     * @param client - LMStudio client
     */
    getFiles(client) {
        return this.getFileParts().map(part => new FileHandle(client.files, part.identifier, part.fileType, part.sizeBytes, part.name));
    }
    /**
     * Allows iterating over the files in the message.
     */
    *files(client) {
        for (const part of this.getFileParts()) {
            yield new FileHandle(client.files, part.identifier, part.fileType, part.sizeBytes, part.name);
        }
    }
    /**
     * Given a predicate, the predicate is called for each file in the message.
     *
     * - If the predicate returns true, the file is removed from the message and is collected into the
     *   returned array.
     * - If the predicate returns false, the file is kept in the message.
     *
     * This method is useful if you are implementing a promptPreprocessor that needs to convert certain
     * types of files.
     *
     * If the predicate needs to be async, use the {@link ChatMessage#consumeFilesAsync} method.
     *
     * @param client - LMStudio client
     * @param predicate - The predicate to call for each file.
     * @returns The files that were consumed.
     */
    consumeFiles(client, predicate) {
        this.guardMutable();
        const consumedFiles = [];
        const partIndexesToRemove = new Set();
        for (const [index, part] of this.data.content.entries()) {
            if (part.type !== "file") {
                continue;
            }
            const file = new FileHandle(client.files, part.identifier, part.fileType, part.sizeBytes, part.name);
            if (predicate(file)) {
                consumedFiles.push(file);
                partIndexesToRemove.add(index);
            }
        }
        this.data.content = this.data.content.filter((_, index) => !partIndexesToRemove.has(index));
        return consumedFiles;
    }
    /**
     * Given an async predicate, the predicate is called for each file in the message.
     *
     * - If the predicate returns true, the file is removed from the message and is collected into the
     *  returned array.
     * - If the predicate returns false, the file is kept in the message.
     *
     * This method is useful if you are implementing a promptPreprocessor that needs to convert certain
     * types of files.
     *
     * If you need a synchronous version, use the {@link ChatMessage#consumeFiles} method.
     *
     * @param client - LMStudio client
     * @param predicate - The predicate to call for each file.
     * @returns The files that were consumed.
     */
    async consumeFilesAsync(client, predicate) {
        this.guardMutable();
        const consumedFiles = [];
        const partIndexesToRemove = new Set();
        for (const [index, part] of this.data.content.entries()) {
            if (part.type !== "file") {
                continue;
            }
            const file = new FileHandle(client.files, part.identifier, part.fileType, part.sizeBytes, part.name);
            if (await predicate(file)) {
                consumedFiles.push(file);
                partIndexesToRemove.add(index);
            }
        }
        this.data.content = this.data.content.filter((_, index) => !partIndexesToRemove.has(index));
        return consumedFiles;
    }
    /**
     * Returns true if this message contains any files.
     */
    hasFiles() {
        return this.data.content.some(part => part.type === "file");
    }
    /**
     * Append text to the message.
     */
    appendText(text) {
        this.guardMutable();
        switch (this.data.role) {
            case "assistant":
            case "user":
            case "system":
                this.data.content.push({
                    type: "text",
                    text,
                });
                break;
            case "tool":
                throw new Error(`Cannot append text to a message with role "${this.data.role}"`);
            default: {
                const exhaustiveCheck = this.data;
                throw new Error(`Unhandled role in switch statement: ${exhaustiveCheck.role}`);
            }
        }
    }
    /**
     * Append a file to the message. Takes in a FileHandle. You can obtain a FileHandle from
     * `client.files.prepareImage`.
     */
    appendFile(file) {
        this.guardMutable();
        switch (this.data.role) {
            case "assistant":
            case "user":
            case "system":
                this.data.content.push({
                    type: "file",
                    name: file.name,
                    identifier: file.identifier,
                    sizeBytes: file.sizeBytes,
                    fileType: file.type,
                });
                break;
            case "tool":
                throw new Error(`Cannot append text to a message with role "${this.data.role}"`);
            default: {
                const exhaustiveCheck = this.data;
                throw new Error(`Unhandled role in switch statement: ${exhaustiveCheck.role}`);
            }
        }
    }
    /**
     * Replaces all text in the messages.
     *
     * If the message contains other components (such as files), they will kept. The replaced text
     * will be inserted to the beginning of the message.
     */
    replaceText(text) {
        this.guardMutable();
        switch (this.data.role) {
            case "assistant":
            case "user":
            case "system":
                this.data.content = [
                    { type: "text", text },
                    ...this.data.content.filter(part => part.type !== "text"),
                ];
                break;
            case "tool":
                throw new Error(`Cannot replace text in a message with role "${this.data.role}"`);
            default: {
                const exhaustiveCheck = this.data;
                throw new Error(`Unhandled role in switch statement: ${exhaustiveCheck.role}`);
            }
        }
    }
    isSystemPrompt() {
        return this.data.role === "system";
    }
    isUserMessage() {
        return this.data.role === "user";
    }
    isAssistantMessage() {
        return this.data.role === "assistant";
    }
    toString() {
        const text = this.data.content
            .map(part => {
            switch (part.type) {
                case "text":
                    return part.text;
                case "file":
                    return `<file ${part.name}>`;
                case "toolCallRequest":
                    return (part.toolCallRequest.name + `(${JSON.stringify(part.toolCallRequest.arguments)})`);
                case "toolCallResult":
                    return part.content;
                default: {
                    const exhaustiveCheck = part;
                    throw new Error(`Unknown part type: ${exhaustiveCheck.type}`);
                }
            }
        })
            .join(" ");
        if (text.includes("\n")) {
            return (this.data.role +
                ":\n" +
                text
                    .split("\n")
                    .map(line => "  " + line)
                    .join("\n"));
        }
        else {
            return this.data.role + ": " + text;
        }
    }
}
const chatMessageLikeSchema = zod.z.union([
    zod.z.instanceof(ChatMessage),
    chatMessageInputSchema,
    zod.z.string(),
    chatMessageDataSchema,
]);

/**
 * A builder for building a KVFieldValueTypeLibrary.
 *
 * The reason why a builder is used is to enable much better type inference when defining the value
 * types.
 */
class KVFieldValueTypesLibraryBuilder {
    constructor(baseSchema) {
        this.baseSchema = baseSchema;
        this.valueTypes = new Map();
    }
    /**
     * Define a new field value type.
     */
    valueType(key, param) {
        if (this.valueTypes.has(key)) {
            throw new Error(`ValueType with key ${key} already exists`);
        }
        this.valueTypes.set(key, {
            paramType: zod.z.object({
                ...this.baseSchema,
                ...param.paramType,
            }),
            schemaMaker: param.schemaMaker,
            effectiveEquals: param.effectiveEquals,
            stringify: param.stringify,
        });
        return this;
    }
    build() {
        return new KVFieldValueTypeLibrary(new Map(this.valueTypes));
    }
}
/**
 * Represents a library of field value types.
 *
 * @public
 */
class KVFieldValueTypeLibrary {
    constructor(valueTypes) {
        this.valueTypes = valueTypes;
    }
    /**
     * Gets the schema for a specific field value type with the given key and parameters.
     */
    getSchema(key, param) {
        const valueType = this.valueTypes.get(key);
        if (valueType === undefined) {
            throw new Error(`Cannot find value type ${key}`);
        }
        return valueType.schemaMaker(valueType.paramType.parse(param));
    }
    parseParamTypes(key, param) {
        return this.valueTypes.get(key).paramType.parse(param);
    }
    effectiveEquals(key, typeParam, a, b) {
        return this.valueTypes.get(key).effectiveEquals(a, b, typeParam);
    }
    stringify(key, typeParam, opts, value) {
        return this.valueTypes.get(key).stringify(value, typeParam, opts);
    }
}
class KVConfigSchematicsBuilder {
    constructor(valueTypeLibrary) {
        this.valueTypeLibrary = valueTypeLibrary;
        this.fields = new Map();
        /**
         * Prefixes for extensions. Does not affect parsing (i.e. extension fields will still not be
         * visible). However, if a key starts with a prefix that is specified here, it will not be removed
         * when going through the lenient zod schema.
         */
        this.extensionPrefixes = [];
    }
    /**
     * Adds a field
     */
    field(key, valueTypeKey, valueTypeParams, defaultValue) {
        const schema = this.valueTypeLibrary.getSchema(valueTypeKey, valueTypeParams);
        const defaultValueParseResult = schema.safeParse(defaultValue);
        if (!defaultValueParseResult.success) {
            throw new Error(`Invalid default value for field ${key}: ${defaultValueParseResult.error.message}`);
        }
        defaultValue = defaultValueParseResult.data;
        if (this.fields.has(key)) {
            throw new Error(`Cannot add field with key ${key}. Key already exists in the schematics.`);
        }
        this.fields.set(key, {
            valueTypeKey,
            valueTypeParams,
            schema: this.valueTypeLibrary.getSchema(valueTypeKey, valueTypeParams),
            fullKey: key,
            defaultValue,
        });
        return this;
    }
    /**
     * Adds an extension point. For example, if called with .extension("hello.world"), then any keys
     * that match "hello.world.*" will be allowed when going through lenient zod schema. However,
     * any extension fields will still not be accessible via this schematics.
     */
    extension(prefix) {
        this.extensionPrefixes.push(`${prefix}.`);
        return this;
    }
    /**
     * Convenience method for grouping a set of fields under a shared namespace.
     *
     * For example, if we want to create two fields: `some:namespace:a` and `some:namespace:b`.
     * Instead of doing:
     *
     * ```ts
     * builder
     *   .field("some:namespace:a", ...)
     *   .field("some:namespace:b", ...)
     * ```
     *
     * We can do:
     *
     * ```ts
     * builder.scope("some:namespace", builder =>
     *  builder
     *   .field("a", ...)
     *   .field("b", ...)
     * )
     * ```
     *
     * This method does support nesting. Whether to nest or not is up to the user.
     */
    scope(scopeKey, fn) {
        const innerBuilder = fn(new KVConfigSchematicsBuilder(this.valueTypeLibrary));
        for (const [key, { valueTypeKey, valueTypeParams, schema, defaultValue },] of innerBuilder.fields.entries()) {
            const fullKey = `${scopeKey}.${key}`;
            if (this.fields.has(fullKey)) {
                throw new Error(`Cannot add field with key ${fullKey}. Key already exists in the schematics.`);
            }
            this.fields.set(fullKey, {
                valueTypeKey,
                valueTypeParams,
                schema,
                fullKey,
                defaultValue,
            });
        }
        this.extensionPrefixes.push(...innerBuilder.extensionPrefixes.map(prefix => `${scopeKey}.${prefix}`));
        return this;
    }
    build() {
        return new KVConfigSchematics(this.valueTypeLibrary, this.fields, this.extensionPrefixes);
    }
}
const createParsedKVConfig = Symbol("createParsedKVConfig");
class KVConfigSchematics {
    constructor(valueTypeLibrary, fields, extensionPrefixes) {
        this.valueTypeLibrary = valueTypeLibrary;
        this.fields = fields;
        this.extensionPrefixes = extensionPrefixes;
        /**
         * Cached full key map
         */
        this.fullKepMap = undefined;
        /**
         * Cached lenient zod schema
         */
        this.lenientZodSchema = undefined;
    }
    getFieldsMap() {
        return new Map([...this.fields.values()].map(field => [field.fullKey, field]));
    }
    obtainField(key) {
        const field = this.fields.get(key);
        if (field === undefined) {
            const fieldKeys = [...this.fields.keys()];
            let availableList = fieldKeys
                .slice(0, 10)
                .map(key => `- ${key}`)
                .join("\n");
            if (fieldKeys.length > 10) {
                availableList += `\n... and ${fieldKeys.length - 10} more`;
            }
            throw new Error(`Cannot access key ${key}. Key does not exist in the schematics. Available keys:\n\n` +
                availableList);
        }
        return field;
    }
    obtainFieldByFullKey(fullKey) {
        const field = this.getFullKeyMap().get(fullKey);
        if (field === undefined) {
            const fieldKeys = [...this.getFullKeyMap().keys()];
            let availableList = fieldKeys
                .slice(0, 10)
                .map(key => `- ${key}`)
                .join("\n");
            if (fieldKeys.length > 10) {
                availableList += `\n... and ${fieldKeys.length - 10} more`;
            }
            throw new Error(`Cannot access full key ${fullKey}. Full key does not exist in the schematics. Available` +
                `keys:\n\n` +
                availableList);
        }
        return field;
    }
    getSchemaForKey(key) {
        const field = this.obtainField(key);
        return field.schema;
    }
    parseField(fieldSchema, value) {
        if (value === undefined) {
            if (fieldSchema.defaultValue === undefined) {
                throw new Error(`Field with key ${fieldSchema.fullKey} is missing and has no default value`);
            }
            return fieldSchema.defaultValue;
        }
        const parseResult = fieldSchema.schema.safeParse(value);
        if (!parseResult.success) {
            throw new Error(`Field with key ${fieldSchema.fullKey} does not satisfy the schema:` +
                parseResult.error.message);
        }
        return parseResult.data;
    }
    parseFieldWithoutDefault(field, value) {
        if (value === undefined) {
            return undefined;
        }
        const parseResult = field.schema.safeParse(value);
        if (!parseResult.success) {
            throw new Error(`Field with key ${field.fullKey} does not satisfy the schema:` + parseResult.error.message);
        }
        return parseResult.data;
    }
    /**
     * Parse and access a field in the config.
     */
    access(config, key) {
        const field = this.obtainField(key);
        return this.parseField(field, config.fields.find(f => f.key === field.fullKey)?.value);
    }
    accessByFullKey(config, fullKey) {
        const field = this.obtainFieldByFullKey(fullKey);
        return this.parseField(field, config.fields.find(f => f.key === field.fullKey)?.value);
    }
    /**
     * Parse and access a field in the config. Returns undefined if the field is missing.
     */
    accessPartial(config, key) {
        const field = this.obtainField(key);
        return this.parseFieldWithoutDefault(field, config.fields.find(f => f.key === field.fullKey)?.value);
    }
    /**
     * Gets a slice of the config schema with the given key patterns. Support syntax:
     *
     * - `some.namespace.key`: Matches exactly `some.namespace.key`
     * - `some.namespace.*`: Matches anything that starts with `some.namespace.`
     */
    sliced(...patterns) {
        const parsedPatterns = patterns.map(p => {
            if (p.endsWith("*")) {
                return { type: "prefix", value: p.substring(0, p.length - 1) };
            }
            return { type: "exact", value: p };
        });
        const newFields = new Map();
        for (const [key, field] of this.fields.entries()) {
            for (const pattern of parsedPatterns) {
                if ((pattern.type === "exact" && key === pattern.value) ||
                    (pattern.type === "prefix" && key.startsWith(pattern.value))) {
                    newFields.set(key, field);
                }
            }
        }
        return new KVConfigSchematics(this.valueTypeLibrary, newFields, this.extensionPrefixes);
    }
    /**
     * Get a subset of the config schema with a specific scope.
     */
    scoped(scopeKey) {
        const newFields = new Map();
        for (const [key, field] of this.fields.entries()) {
            if (key.startsWith(`${scopeKey}.`)) {
                newFields.set(key.substring(scopeKey.length + 1), field);
            }
        }
        return new KVConfigSchematics(this.valueTypeLibrary, newFields, this.extensionPrefixes);
    }
    union(other) {
        const newFields = new Map();
        for (const [key, field] of this.fields.entries()) {
            newFields.set(key, field);
        }
        for (const [key, field] of other.fields.entries()) {
            if (newFields.has(key)) {
                throw new Error("Cannot union two KVConfigSchematics. The following key is duplicated: " + key);
            }
            newFields.set(key, field);
        }
        return new KVConfigSchematics(this.valueTypeLibrary, newFields, [
            ...this.extensionPrefixes,
            ...other.extensionPrefixes,
        ]);
    }
    /**
     * Combine baseKey into the fields. Effectively removes the baseKey.
     */
    flattenBaseKey() {
        const newFields = new Map();
        for (const field of this.fields.values()) {
            newFields.set(field.fullKey, field);
        }
        return new KVConfigSchematics(this.valueTypeLibrary, newFields, this.extensionPrefixes);
    }
    parseToMap(config) {
        const rawConfigMap = kvConfigToMap(config);
        const parsedConfigMap = new Map();
        for (const [key, field] of this.fields.entries()) {
            const value = rawConfigMap.get(field.fullKey);
            const parsedValue = this.parseField(field, value);
            parsedConfigMap.set(key, parsedValue);
        }
        return parsedConfigMap;
    }
    parseToMapWithFullKey(config) {
        const rawConfigMap = kvConfigToMap(config);
        const parsedConfigMap = new Map();
        for (const field of this.fields.values()) {
            const value = rawConfigMap.get(field.fullKey);
            const parsedValue = this.parseField(field, value);
            parsedConfigMap.set(field.fullKey, parsedValue);
        }
        return parsedConfigMap;
    }
    parseToMapPartial(config) {
        const rawConfigMap = kvConfigToMap(config);
        const parsedConfigMap = new Map();
        for (const [key, field] of this.fields.entries()) {
            const value = rawConfigMap.get(field.fullKey);
            const parsedValue = this.parseFieldWithoutDefault(field, value);
            if (parsedValue !== undefined) {
                parsedConfigMap.set(key, parsedValue);
            }
        }
        return parsedConfigMap;
    }
    /**
     * Parse the given config to a ParsedKVConfig. **Will throw** if the config does not satisfy the
     * schema.
     */
    parse(config) {
        return ParsedKVConfig[createParsedKVConfig](this.parseToMap(config));
    }
    parsePartial(config) {
        return PartialParsedKVConfig[createParsedKVConfig](this.parseToMapPartial(config));
    }
    /**
     * Builds a full KV config from the given values record. **Will throw** if any of the values are
     * missing or do not satisfy the schema.
     */
    buildFullConfig(valuesRecord) {
        return {
            fields: Array.from(this.fields.entries()).map(([key, field]) => {
                const value = this.parseField(field, valuesRecord[key]);
                return { key: field.fullKey, value };
            }),
        };
    }
    /**
     * Builds a partial KV config from the given values record. Will leave holes in the config if the
     * values are missing. **Will throw** if any of the values do not satisfy the schema.
     */
    buildPartialConfig(valuesRecord) {
        return {
            fields: Object.entries(valuesRecord)
                .filter(([_key, value]) => value !== undefined)
                .map(([key, value]) => {
                const field = this.obtainField(key);
                return { key: field.fullKey, value: this.parseField(field, value) };
            }),
        };
    }
    createBuildPartialConfigInput() {
        return {};
    }
    configBuilder() {
        return new KVConfigBuilder(this.fields);
    }
    clone() {
        return new KVConfigSchematics(this.valueTypeLibrary, new Map(this.fields), this.extensionPrefixes);
    }
    withTypeParamOverride(key, paramMapper) {
        const field = this.obtainField(key);
        const clone = this.clone();
        clone.fields.set(key, {
            ...field,
            valueTypeParams: paramMapper(field.valueTypeParams),
            schema: this.valueTypeLibrary.getSchema(field.valueTypeKey, paramMapper(field.valueTypeParams)),
        });
        return clone;
    }
    getFullKeyMap() {
        if (this.fullKepMap !== undefined) {
            return this.fullKepMap;
        }
        this.fullKepMap = new Map([...this.fields.values()].map(field => [field.fullKey, field]));
        return this.fullKepMap;
    }
    makeLenientZodSchema() {
        const fullKeyMap = this.getFullKeyMap();
        return kvConfigSchema.transform(value => {
            const seenKeys = new Set();
            return {
                fields: value.fields.filter(field => {
                    if (this.extensionPrefixes.some(prefix => field.key.startsWith(prefix))) {
                        // If we matched an extension prefix, we don't care about the key or value type. Just
                        // allow it.
                        return true;
                    }
                    if (seenKeys.has(field.key)) {
                        return false;
                    }
                    const fieldDef = fullKeyMap.get(field.key);
                    if (fieldDef === undefined) {
                        return false;
                    }
                    const parsed = fieldDef.schema.safeParse(field.value);
                    if (!parsed.success) {
                        return false;
                    }
                    seenKeys.add(field.key);
                    return true;
                }),
            };
        });
    }
    /**
     * Makes a zod schema that parses a KVConfig which only allows fields with correct keys and types
     * through.
     *
     * Will filter out any fields that are not in the schema.
     */
    getLenientZodSchema() {
        if (this.lenientZodSchema !== undefined) {
            return this.lenientZodSchema;
        }
        this.lenientZodSchema = this.makeLenientZodSchema();
        return this.lenientZodSchema;
    }
    getValueType(key) {
        const field = this.fields.get(key);
        if (field === undefined) {
            return null;
        }
        return field.valueTypeKey;
    }
    getValueTypeParam(key) {
        const field = this.fields.get(key);
        if (field === undefined) {
            return null;
        }
        return field.valueTypeParams;
    }
    getValueTypeParamByFullKey(key) {
        const field = this.getFullKeyMap().get(key);
        if (field === undefined) {
            throw new Error(`Field with key ${key} does not exist in the schematics`);
        }
        return field.valueTypeParams;
    }
    hasFullKey(key) {
        const field = this.getFullKeyMap().get(key);
        return field !== undefined;
    }
    /**
     * Given a KVConfig, filter it to only include fields that are in the schematics.
     */
    filterConfig(config, additionalFilter) {
        const fullKeyMap = this.getFullKeyMap();
        return {
            fields: config.fields.filter(configField => {
                const field = fullKeyMap.get(configField.key);
                if (field === undefined) {
                    return false;
                }
                if (additionalFilter !== undefined) {
                    return additionalFilter(field.fullKey, {
                        type: field.valueTypeKey,
                        param: field.valueTypeParams,
                    });
                }
                return true;
            }),
        };
    }
    /**
     * Given a KVConfigStack, filter it to only include fields that are in the schematics.
     */
    filterStack(stack) {
        return {
            layers: stack.layers.map(layer => ({
                layerName: layer.layerName,
                config: this.filterConfig(layer.config),
            })),
        };
    }
    twoWayFilterConfig(config, additionalFilter) {
        const includedFields = [];
        const excludedFields = [];
        const fullKeyMap = this.getFullKeyMap();
        for (const configField of config.fields) {
            const field = fullKeyMap.get(configField.key);
            let include = field !== undefined;
            if (field !== undefined && additionalFilter !== undefined) {
                include = additionalFilter(field.fullKey, {
                    type: field.valueTypeKey,
                    param: field.valueTypeParams,
                });
            }
            if (include) {
                includedFields.push(configField);
            }
            else {
                excludedFields.push(configField);
            }
        }
        return [{ fields: includedFields }, { fields: excludedFields }];
    }
    /**
     * Given a list of keys, filter it to only include keys that are in the schematics.
     */
    filterFullKeys(keys) {
        const fullKeyMap = this.getFullKeyMap();
        return keys.filter(key => fullKeyMap.has(key));
    }
    /**
     * Compares two KV config. Compare with "effective equals". Only compare fields in the schematics.
     * Does not apply defaults.
     */
    configEffectiveEquals(a, b) {
        const aMap = kvConfigToMap(a);
        const bMap = kvConfigToMap(b);
        for (const field of this.fields.values()) {
            const aValue = aMap.get(field.fullKey);
            const bValue = bMap.get(field.fullKey);
            if (aValue === undefined) {
                if (bValue === undefined) {
                    // Both are missing, continue
                    continue;
                }
                else {
                    return false;
                }
            }
            this.valueTypeLibrary.effectiveEquals(field.valueTypeKey, field.valueTypeParams, aValue, bValue);
        }
        return true;
    }
    /**
     * Compares two KV config field. Compare with "effective equals". Can only compare fields in the
     * schematics.
     */
    fieldEffectiveEquals(key, a, b) {
        const field = this.obtainField(key);
        return this.valueTypeLibrary.effectiveEquals(field.valueTypeKey, field.valueTypeParams, field.schema.parse(a), field.schema.parse(b));
    }
    fieldEffectiveEqualsWithFullKey(fullKey, a, b) {
        const fullKeyMap = this.getFullKeyMap();
        const field = fullKeyMap.get(fullKey);
        if (field === undefined) {
            throw new Error(`Field with key ${fullKey} does not exist in the schematics`);
        }
        return this.valueTypeLibrary.effectiveEquals(field.valueTypeKey, field.valueTypeParams, field.schema.parse(a), field.schema.parse(b));
    }
    makeInternalFieldStringifyOpts(opts) {
        return {
            t: opts.t ?? ((_key, fallback) => fallback),
            desiredLength: opts.desiredLength,
        };
    }
    stringifyField(key, value, opts = {}) {
        const field = this.obtainField(key);
        return this.valueTypeLibrary.stringify(field.valueTypeKey, field.valueTypeParams, this.makeInternalFieldStringifyOpts(opts), value);
    }
    tryStringifyFieldWithFullKey(key, value, opts) {
        const fullKeyMap = this.getFullKeyMap();
        const field = fullKeyMap.get(key);
        if (field === undefined) {
            return null;
        }
        return this.valueTypeLibrary.stringify(field.valueTypeKey, field.valueTypeParams, this.makeInternalFieldStringifyOpts(opts), value);
    }
    /**
     * Apply config in patch to target. Only apply fields that are in the schematics.
     */
    apply(target, patch) {
        const filteredPatch = this.filterConfig(patch);
        return collapseKVStackRaw([target, filteredPatch]);
    }
    /**
     * Tries to un-apply the patch from the target. Will only un-apply fields that are in the
     * schematics.
     *
     * If the value in the target is not effective equal to the value in the patch, it will not be
     * removed.
     */
    unApply(target, patch) {
        const filteredPatch = this.filterConfig(patch);
        const patchMap = kvConfigToMap(filteredPatch);
        const newMap = new Map(kvConfigToMap(target));
        const fullKeyMap = this.getFullKeyMap();
        for (const [key, value] of patchMap.entries()) {
            const field = fullKeyMap.get(key);
            if (field === undefined) {
                continue;
            }
            const targetValue = newMap.get(key);
            if (targetValue !== undefined) {
                if (!this.valueTypeLibrary.effectiveEquals(field.valueTypeKey, field.valueTypeParams, value, targetValue)) {
                    continue;
                }
                newMap.delete(key);
            }
        }
        return mapToKVConfig(newMap);
    }
    /**
     * Given a KVConfig, iterate through all the fields that are in the schematics. Keys will be full
     * keys.
     */
    *iterateFieldsOfConfig(config) {
        const fullKeyMap = this.getFullKeyMap();
        for (const { key, value } of config.fields) {
            const field = fullKeyMap.get(key);
            if (field !== undefined) {
                yield [key, value];
            }
        }
    }
    /**
     * Given a KVConfig, iterate through all the fields that are in the schematics.
     */
    *fullKeys() {
        const fullKeyMap = this.getFullKeyMap();
        for (const key of fullKeyMap.keys()) {
            yield key;
        }
    }
    /**
     * Effectively compare two KV config, and return full keys of fields that are different.
     */
    effectiveCompareConfig(a, b, opts = {}) {
        const { fieldFilter } = opts;
        const aMap = kvConfigToMap(a);
        const bMap = kvConfigToMap(b);
        const onlyInA = [];
        const onlyInB = [];
        const inBothButDifferent = [];
        for (const field of this.fields.values()) {
            if (fieldFilter !== undefined) {
                if (!fieldFilter(field.fullKey, {
                    type: field.valueTypeKey,
                    param: field.valueTypeParams,
                })) {
                    continue;
                }
            }
            const aValue = aMap.get(field.fullKey);
            const bValue = bMap.get(field.fullKey);
            if (aValue === undefined) {
                if (bValue === undefined) {
                    continue;
                }
                else {
                    onlyInB.push(field.fullKey);
                }
            }
            else {
                if (bValue === undefined) {
                    onlyInA.push(field.fullKey);
                }
                else {
                    if (!this.valueTypeLibrary.effectiveEquals(field.valueTypeKey, field.valueTypeParams, aValue, bValue)) {
                        inBothButDifferent.push(field.fullKey);
                    }
                }
            }
        }
        return { onlyInA, onlyInB, inBothButDifferent };
    }
    serialize() {
        return {
            fields: [...this.fields.entries()].map(([key, field]) => ({
                shortKey: key,
                fullKey: field.fullKey,
                typeKey: field.valueTypeKey,
                typeParams: field.valueTypeParams,
                defaultValue: field.defaultValue,
            })),
            extensionPrefixes: this.extensionPrefixes,
        };
    }
    /**
     * Check if any of the fields in the schematics has a full key that starts with the given prefix.
     */
    hasFieldsWithPrefix(prefix) {
        for (const field of this.fields.values()) {
            if (field.fullKey.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }
    static deserialize(valueTypeLibrary, serialized) {
        const fields = new Map(serialized.fields.map(field => {
            const typeParams = valueTypeLibrary.parseParamTypes(field.typeKey, field.typeParams);
            const valueSchema = valueTypeLibrary.getSchema(field.typeKey, typeParams);
            return [
                field.shortKey,
                {
                    valueTypeKey: field.typeKey,
                    valueTypeParams: typeParams,
                    schema: valueSchema,
                    fullKey: field.fullKey,
                    defaultValue: valueSchema.parse(field.defaultValue),
                },
            ];
        }));
        return new KVConfigSchematics(valueTypeLibrary, fields, serialized.extensionPrefixes ?? []);
    }
    static tryDeserialize(valueTypeLibrary, serialized) {
        const fields = new Map();
        const errors = [];
        for (const field of serialized.fields) {
            try {
                const typeParams = valueTypeLibrary.parseParamTypes(field.typeKey, field.typeParams);
                const valueSchema = valueTypeLibrary.getSchema(field.typeKey, typeParams);
                fields.set(field.shortKey, {
                    valueTypeKey: field.typeKey,
                    valueTypeParams: typeParams,
                    schema: valueSchema,
                    fullKey: field.fullKey,
                    defaultValue: valueSchema.parse(field.defaultValue),
                });
            }
            catch (error) {
                errors.push({
                    fullKey: field.fullKey,
                    error: serializeError(error),
                });
            }
        }
        return {
            schematics: new KVConfigSchematics(valueTypeLibrary, fields, serialized.extensionPrefixes ?? []),
            errors,
        };
    }
}
class KVConfigBuilder {
    constructor(fieldDefs) {
        this.fieldDefs = fieldDefs;
        this.fields = new Map();
    }
    with(key, value) {
        const field = this.fieldDefs.get(key);
        if (field === undefined) {
            throw new Error(`Field with key ${key} does not exist in the schematics.`);
        }
        this.fields.set(field.fullKey, value);
        return this;
    }
    build() {
        return mapToKVConfig(this.fields);
    }
}
/**
 * This class can be only constructed via the `parse` method on `KVConfigSchema`. It is guaranteed
 * to satisfy the schema.
 *
 * All fields that exist on the schematics is guaranteed to exist here.
 */
class ParsedKVConfig {
    constructor(
    /**
     * Guaranteed to satisfy the schema.
     */
    configMap) {
        this.configMap = configMap;
    }
    /**
     * @internal
     */
    static [createParsedKVConfig](configMap) {
        return new ParsedKVConfig(configMap);
    }
    get(key) {
        return this.configMap.get(key);
    }
}
/**
 * This class can be constructed via the `parsePartial` method on `KVConfigSchema`. All existing
 * fields are guaranteed to satisfy the schema. However, there may be missing fields.
 */
class PartialParsedKVConfig {
    constructor(
    /**
     * Guaranteed to satisfy the schema.
     */
    configMap) {
        this.configMap = configMap;
    }
    static [createParsedKVConfig](configMap) {
        return new PartialParsedKVConfig(configMap);
    }
    get(key) {
        return this.configMap.get(key);
    }
    has(key) {
        return this.configMap.has(key);
    }
}
function kvConfigToMap(config) {
    return new Map(config.fields.map(f => [f.key, f.value]));
}
function mapToKVConfig(map) {
    return {
        fields: Array.from(map.entries()).map(([key, value]) => ({ key, value })),
    };
}
function collapseKVStackRaw(configs) {
    const map = new Map();
    for (const config of configs) {
        for (const { key, value } of config.fields) {
            map.set(key, value);
        }
    }
    return mapToKVConfig(map);
}
const emptyKVConfig = {
    fields: [],
};
function singleLayerKVConfigStackOf(name, config) {
    return {
        layers: [
            {
                layerName: name,
                config,
            },
        ],
    };
}
/**
 * Given a KVConfigStack, add a new layer to the top of the stack. Does not mutate the original
 * stack.
 */
function addKVConfigToStack(stack, newLayerName, newLayerConfig) {
    return {
        layers: [
            ...stack.layers,
            {
                layerName: newLayerName,
                config: newLayerConfig,
            },
        ],
    };
}
function deepEquals(a, b) {
    if (a === b) {
        return true;
    }
    if (typeof a !== "object" || typeof b !== "object") {
        return false;
    }
    if (a === null || b === null) {
        return false;
    }
    if (Array.isArray(a) !== Array.isArray(b)) {
        return false;
    }
    if (Array.isArray(a)) {
        if (a.length !== b?.length) {
            return false;
        }
        for (let i = 0; i < a.length; i++) {
            if (!deepEquals(a[i], b[i])) {
                return false;
            }
        }
        return true;
    }
    const aKeys = new Set(Object.keys(a));
    const bKeys = new Set(Object.keys(b));
    if (aKeys.size !== bKeys.size) {
        return false;
    }
    for (const key of aKeys) {
        if (!bKeys.has(key)) {
            return false;
        }
        if (!deepEquals(a[key], b[key])) {
            return false;
        }
    }
    return true;
}

/**
 * Quote a string.
 */
function quoteString(str, empty) {
    if (str === undefined || str === "") {
        return empty ?? '""';
    }
    return JSON.stringify(str);
}
/**
 * Quote a string that may include manual escape. (i.e. newlines represented with "\\n")
 */
function quoteStringWithManualEscape(str, empty) {
    return quoteString(str?.replace(/\\n/g, "\n"), empty);
}
/**
 * Builder for all the basic KV types.
 *
 * @public
 */
const baseKVValueTypesLibraryBuilder = new KVFieldValueTypesLibraryBuilder({
    /**
     * Display name of the field.
     */
    displayName: zod.z.string().optional(),
    /**
     * Hint about the field. Shown when hovering over the field.
     */
    hint: zod.z.string().optional(),
    /**
     * A field can be marked as model centric when it loses its meaning when there is no model to
     * reference.
     *
     * An example would be prompt template. There is no point to configure prompt template when there
     * isn't a specific model.
     *
     * @experimental This field is experimental and may change in the future.
     */
    modelCentric: zod.z.boolean().optional(),
    /**
     * A field can be marked as non-configurable when it is only used as a means to carry information.
     * As a result, it will not be shown in the UI.
     *
     * An example would be context length for MLX, as you cannot change it.
     *
     * @experimental This field is experimental and may change in the future.
     */
    nonConfigurable: zod.z.boolean().optional(),
    /**
     * A field can be marked as engineDoesNotSupport when when the engine running the model does not
     * support the field.
     *
     * @experimental This field is experimental and may change in the future.
     */
    engineDoesNotSupport: zod.z.boolean().optional(),
    /**
     * A field can be marked as machine dependent when its value is highly dependent on the machine
     * that is being used. When exporting the config, one may decide to not include machine dependent
     * fields by default.
     *
     * An example would be GPU offload settings.
     *
     * @experimental This field is experimental and may change in the future.
     */
    machineDependent: zod.z.boolean().optional(),
    warning: zod.z.string().optional(),
    subtitle: zod.z.string().optional(),
    isExperimental: zod.z.boolean().optional(),
    dependencies: zod.z.array(kvConfigFieldDependencySchema).optional(),
})
    .valueType("numeric", {
    paramType: {
        min: zod.z.number().optional(),
        max: zod.z.number().optional(),
        step: zod.z.number().optional(),
        int: zod.z.boolean().optional(),
        precision: zod.z.number().int().nonnegative().optional(),
        slider: zod.z
            .object({
            min: zod.z.number(),
            max: zod.z.number(),
            step: zod.z.number(),
        })
            .optional(),
        shortHand: zod.z.string().optional(),
    },
    schemaMaker: ({ min, max, int, precision }) => {
        let schema = zod.z.number();
        if (min !== undefined) {
            schema = schema.min(min);
        }
        if (max !== undefined) {
            schema = schema.max(max);
        }
        if (int) {
            if (precision !== undefined) {
                throw new Error("Cannot specify both int and precision.");
            }
            schema = schema.int();
        }
        return schema;
    },
    effectiveEquals: (a, b) => {
        return a === b;
    },
    stringify: (value, { int, precision }) => {
        if (int) {
            return String(Math.round(value));
        }
        return value.toFixed(precision ?? 2);
    },
})
    .valueType("string", {
    paramType: {
        minLength: zod.z.number().optional(),
        maxLength: zod.z.number().optional(),
        isParagraph: zod.z.boolean().optional(),
        isProtected: zod.z.boolean().optional(),
        /**
         * If true, the string should match to a single token.
         */
        isToken: zod.z.boolean().optional(),
        placeholder: zod.z.string().optional(),
    },
    schemaMaker: ({ minLength, maxLength }) => {
        let schema = zod.z.string();
        if (minLength !== undefined) {
            schema = schema.min(minLength);
        }
        if (maxLength !== undefined) {
            schema = schema.max(maxLength);
        }
        return schema;
    },
    effectiveEquals: (a, b) => {
        return a === b;
    },
    stringify: (value, { isParagraph, isProtected }, { t, desiredLength }) => {
        if (isProtected) {
            return "********";
        }
        if (isParagraph) {
            if (value === "") {
                return t("config:customInputs.string.emptyParagraph", "<Empty>");
            }
            else {
                if (desiredLength === undefined || value.length <= desiredLength) {
                    return value;
                }
                else {
                    return (value.slice(0, Math.floor(desiredLength / 2)) +
                        " ... " +
                        value.slice(-Math.ceil(desiredLength / 2)));
                }
            }
        }
        else {
            const quoted = quoteString(value);
            if (desiredLength === undefined || quoted.length <= desiredLength) {
                return quoted;
            }
            else {
                return (quoted.slice(0, Math.floor(desiredLength / 2)) +
                    "..." +
                    quoted.slice(-Math.ceil(desiredLength / 2)));
            }
        }
    },
})
    .valueType("select", {
    paramType: {
        options: zod.z
            .array(zod.z.object({ value: zod.z.string().nonempty(), displayName: zod.z.string() }).or(zod.z.string()))
            .refine(options => {
            // See if there are any duplicate values.
            const values = new Set();
            for (const option of options) {
                const value = typeof option === "string" ? option : option.value;
                if (values.has(value)) {
                    return false;
                }
                values.add(value);
            }
            return true;
        }, {
            message: "Duplicate values in options.",
        }),
    },
    schemaMaker: ({ options }) => {
        const allowedValues = new Set(options.map(option => (typeof option === "string" ? option : option.value)));
        return zod.z.string().refine(value => allowedValues.has(value));
    },
    effectiveEquals: (a, b) => {
        return a === b;
    },
    stringify: value => {
        return value;
    },
})
    .valueType("boolean", {
    paramType: {},
    schemaMaker: () => {
        return zod.z.boolean();
    },
    effectiveEquals: (a, b) => {
        return a === b;
    },
    stringify: value => {
        return value ? "ON" : "OFF";
    },
})
    .valueType("stringArray", {
    paramType: {
        maxNumItems: zod.z.number().optional(),
        /**
         * Whether to allow empty strings in the array. Default is false.
         */
        allowEmptyStrings: zod.z.boolean().optional(),
    },
    schemaMaker: ({ maxNumItems, allowEmptyStrings }) => {
        let stringSchema = zod.z.string();
        if (!allowEmptyStrings) {
            stringSchema = stringSchema.min(1);
        }
        let schema = zod.z.array(stringSchema);
        if (maxNumItems !== undefined) {
            schema = schema.max(maxNumItems);
        }
        return schema;
    },
    effectiveEquals: (a, b) => {
        return a.length === b.length && a.every((v, i) => v === b[i]);
    },
    stringify: (value, _typeParam, { t, desiredLength }) => {
        const quoted = value.map(v => quoteString(v));
        if (quoted.length === 0) {
            return t("config:customInputs.stringArray.empty", "<Empty>");
        }
        if (quoted.length <= 2 || desiredLength === undefined) {
            return quoted.join(", ");
        }
        // Desired length does not need to be followed strictly. It is just a hint.
        let currentLength = quoted[0].length + quoted[1].length + 6;
        for (let i = 1; i < quoted.length - 1; i++) {
            currentLength += quoted[i].length + 2;
            if (currentLength >= desiredLength) {
                return quoted.slice(0, i).join(", ") + ", ..." + quoted[quoted.length - 1];
            }
        }
        return quoted.join(", ");
    },
});
/**
 * Basic key-value field value types library. These are the types that are exposed to plugins.
 *
 * @public
 */
baseKVValueTypesLibraryBuilder.build();
/**
 * The global key-value field value types library. This includes all the basic types and additional
 * types that are used in the LM Studio application.
 *
 * @public
 */
const kvValueTypesLibrary = baseKVValueTypesLibraryBuilder
    .valueType("checkboxNumeric", {
    paramType: {
        min: zod.z.number().optional(),
        max: zod.z.number().optional(),
        step: zod.z.number().optional(),
        int: zod.z.boolean().optional(),
        uncheckedHint: zod.z.string().optional(),
        precision: zod.z.number().int().nonnegative().optional(),
        slider: zod.z
            .object({
            min: zod.z.number(),
            max: zod.z.number(),
            step: zod.z.number(),
        })
            .optional(),
    },
    schemaMaker: ({ min, max, int, precision }) => {
        let numberSchema = zod.z.number();
        if (min !== undefined) {
            numberSchema = numberSchema.min(min);
        }
        if (max !== undefined) {
            numberSchema = numberSchema.max(max);
        }
        if (int) {
            if (precision !== undefined) {
                throw new Error("Cannot specify both int and precision.");
            }
            numberSchema = numberSchema.int();
        }
        return zod.z.object({
            checked: zod.z.boolean(),
            value: numberSchema,
        });
    },
    effectiveEquals: (a, b) => {
        if (a.checked !== b.checked) {
            return false;
        }
        if (!a.checked) {
            return true;
        }
        return a.value === b.value;
    },
    stringify: (value, { int, precision }, { t }) => {
        if (!value.checked) {
            return t("config:customInputs.checkboxNumeric.off", "OFF");
        }
        if (int) {
            return String(Math.round(value.value));
        }
        return value.value.toFixed(precision ?? 2);
    },
})
    .valueType("numericArray", {
    paramType: {
        min: zod.z.number().optional(),
        max: zod.z.number().optional(),
        int: zod.z.boolean().optional(),
    },
    schemaMaker: ({ min, max, int }) => {
        let numberSchema = zod.z.number();
        if (min !== undefined) {
            numberSchema = numberSchema.min(min);
        }
        if (max !== undefined) {
            numberSchema = numberSchema.max(max);
        }
        if (int) {
            numberSchema = numberSchema.int();
        }
        return zod.z.array(numberSchema);
    },
    effectiveEquals: (a, b) => {
        return a.length === b.length && a.every((v, i) => v === b[i]);
    },
    stringify: (value, { int }) => {
        return value.map(v => (int ? String(Math.round(v)) : String(v))).join(", ");
    },
})
    .valueType("contextOverflowPolicy", {
    paramType: {},
    schemaMaker: () => {
        return llmContextOverflowPolicySchema;
    },
    effectiveEquals: (a, b) => {
        return a === b;
    },
    stringify: (value, _typeParam, { t }) => {
        switch (value) {
            case "stopAtLimit":
                return t("config:customInputs.contextOverflowPolicy.stopAtLimit", "Stop At Limit");
            case "truncateMiddle":
                return t("config:customInputs.contextOverflowPolicy.truncateMiddle", "Truncate Middle");
            case "rollingWindow":
                return t("config:customInputs.contextOverflowPolicy.rollingWindow", "Rolling Window");
        }
    },
})
    .valueType("context", {
    paramType: {},
    schemaMaker: () => {
        return zod.z.array(llmContextReferenceSchema);
    },
    effectiveEquals: (a, b) => {
        return deepEquals(a, b);
    },
    stringify: value => {
        return JSON.stringify(value, null, 2); // TODO: pretty print
    },
})
    .valueType("contextLength", {
    paramType: {
        max: zod.z.number().optional(),
    },
    schemaMaker: () => {
        return zod.z.number().int().positive();
    },
    effectiveEquals: (a, b) => {
        return a === b;
    },
    stringify: (value, { max }) => {
        if (max === undefined) {
            return String(value);
        }
        return `${value}/${max}`;
    },
})
    .valueType("modelIdentifier", {
    paramType: {
        domain: zod.z.array(modelDomainTypeSchema).optional(),
    },
    schemaMaker: () => {
        return zod.z.string();
    },
    effectiveEquals: (a, b) => {
        return a === b;
    },
    stringify: value => {
        return value;
    },
})
    .valueType("llmPromptTemplate", {
    paramType: {},
    schemaMaker: () => {
        return llmPromptTemplateSchema;
    },
    effectiveEquals: (a, b) => {
        if (a.type !== b.type) {
            return false;
        }
        if (a.stopStrings.length !== b.stopStrings.length) {
            return false;
        }
        if (!a.stopStrings.every((v, i) => v === b.stopStrings[i])) {
            return false;
        }
        switch (a.type) {
            case "jinja":
                return a.jinjaPromptTemplate?.template === b.jinjaPromptTemplate?.template;
            case "manual":
                return (a.manualPromptTemplate?.beforeSystem === b.manualPromptTemplate?.beforeSystem &&
                    a.manualPromptTemplate?.afterSystem === b.manualPromptTemplate?.afterSystem &&
                    a.manualPromptTemplate?.beforeUser === b.manualPromptTemplate?.beforeUser &&
                    a.manualPromptTemplate?.afterUser === b.manualPromptTemplate?.afterUser &&
                    a.manualPromptTemplate?.beforeAssistant === b.manualPromptTemplate?.beforeAssistant &&
                    a.manualPromptTemplate?.afterAssistant === b.manualPromptTemplate?.afterAssistant);
            default: {
                const exhaustiveCheck = a.type;
                throw new Error("Unknown template type: " + exhaustiveCheck);
            }
        }
    },
    stringify: (value, _typeParam, { t, desiredLength }) => {
        switch (value.type) {
            case "jinja": {
                const lead = `${t("config:customInputs.llmPromptTemplate.type", "Type")}: ` +
                    `${t("config:customInputs.llmPromptTemplate.types.jinja/label", "Jinja")}\n` +
                    `${t("config:customInputs.llmPromptTemplate.jinja.template/label", "Template")}: `;
                if (desiredLength === undefined) {
                    return lead + value.jinjaPromptTemplate?.template;
                }
                const currentLength = lead.length;
                const remainingLength = Math.min(100, desiredLength - currentLength);
                const template = value.jinjaPromptTemplate?.template ?? "";
                if (template.length <= remainingLength) {
                    return lead + template;
                }
                return (lead +
                    template.slice(0, Math.floor(remainingLength / 2)) +
                    "..." +
                    template.slice(-Math.ceil(remainingLength / 2)));
            }
            case "manual": {
                return (`${t("config:customInputs.llmPromptTemplate.type", "Type")}: ` +
                    `${t("config:customInputs.llmPromptTemplate.types.manual/label", "Manual")}\n` +
                    `${t("config:customInputs.llmPromptTemplate.manual.subfield.beforeSystem/label", "Before System")}: ` +
                    `${quoteStringWithManualEscape(value.manualPromptTemplate?.beforeSystem)}\n` +
                    `${t("config:customInputs.llmPromptTemplate.manual.subfield.afterSystem/label", "After System")}: ` +
                    `${quoteStringWithManualEscape(value.manualPromptTemplate?.afterSystem)}\n` +
                    `${t("config:customInputs.llmPromptTemplate.manual.subfield.beforeUser/label", "Before User")}: ` +
                    `${quoteStringWithManualEscape(value.manualPromptTemplate?.beforeUser)}\n` +
                    `${t("config:customInputs.llmPromptTemplate.manual.subfield.afterUser/label", "After User")}: ` +
                    `${quoteStringWithManualEscape(value.manualPromptTemplate?.afterUser)}\n` +
                    `${t("config:customInputs.llmPromptTemplate.manual.subfield.beforeAssistant/label", "Before Assistant")}: ` +
                    `${quoteStringWithManualEscape(value.manualPromptTemplate?.beforeAssistant)}\n` +
                    `${t("config:customInputs.llmPromptTemplate.manual.subfield.afterAssistant/label", "After Assistant")}: ` +
                    `${quoteStringWithManualEscape(value.manualPromptTemplate?.afterAssistant)}`);
            }
            default: {
                const exhaustiveCheck = value.type;
                throw new Error("Unknown template type: " + exhaustiveCheck);
            }
        }
    },
})
    .valueType("llmReasoningParsing", {
    paramType: {},
    schemaMaker: () => {
        return llmReasoningParsingSchema;
    },
    effectiveEquals: (a, b) => {
        return a.startString === b.startString && a.endString === b.endString;
    },
    stringify: value => {
        return JSON.stringify(value, null, 2); // TODO: pretty print
    },
})
    .valueType("llamaStructuredOutput", {
    paramType: {},
    schemaMaker: () => {
        return llmStructuredPredictionSettingSchema;
    },
    effectiveEquals: (a, b) => {
        if (a.type === "json" && b.type === "json") {
            return deepEquals(a, b);
        }
        else if (a.type === "none" && b.type === "none") {
            return true;
        }
        else {
            return false;
        }
    },
    stringify: value => {
        return JSON.stringify(value, null, 2); // TODO: pretty print
    },
})
    .valueType("speculativeDecodingDraftModel", {
    paramType: {},
    schemaMaker: () => {
        // Empty string means no speculative decoding.
        return zod.z.string();
    },
    effectiveEquals: (a, b) => {
        return a === b;
    },
    stringify: (value, _typeParam, { t }) => {
        if (value === "") {
            return t("config:customInputs.speculativeDecodingDraftModel.off", "OFF");
        }
        return value;
    },
})
    .valueType("toolUse", {
    paramType: {},
    schemaMaker: () => {
        return llmToolUseSettingSchema;
    },
    effectiveEquals: (a, b) => {
        return deepEquals(a, b); // TODO: more performant comparison
    },
    stringify: value => {
        return JSON.stringify(value, null, 2); // TODO: pretty print
    },
})
    .valueType("toolNaming", {
    paramType: {},
    schemaMaker: () => {
        return toolNamingSchema;
    },
    effectiveEquals: (a, b) => {
        return a === b;
    },
    stringify: value => {
        return value;
    },
})
    .valueType("llamaAccelerationOffloadRatio", {
    paramType: {
        numLayers: zod.z.number().optional(),
    },
    schemaMaker: () => {
        return llmLlamaAccelerationOffloadRatioSchema;
    },
    effectiveEquals: (a, b) => {
        const ratioA = a === "max" ? 1 : a === "off" ? 0 : a;
        const ratioB = b === "max" ? 1 : b === "off" ? 0 : b;
        return ratioA === ratioB;
    },
    stringify: (value, { numLayers }, { t }) => {
        if (value === "max" || value === 1) {
            const label = t("config:customInputs.llamaAccelerationOffloadRatio.max", "MAX");
            if (numLayers !== 0) {
                return `${label} (${numLayers})`;
            }
            return label;
        }
        if (value === "off" || value === 0) {
            return t("config:customInputs.llamaAccelerationOffloadRatio.off", "OFF");
        }
        if (numLayers !== undefined) {
            return String(Math.round(numLayers * value));
        }
        return (value * 100).toFixed(0) + "%";
    },
})
    .valueType("llamaMirostatSampling", {
    paramType: {},
    schemaMaker: () => {
        return llmLlamaMirostatSamplingConfigSchema;
    },
    effectiveEquals: (a, b) => {
        return deepEquals(a, b); // TODO: more performant comparison
    },
    stringify: value => {
        return JSON.stringify(value, null, 2); // TODO: pretty print
    },
})
    .valueType("llamaLogitBias", {
    paramType: {},
    schemaMaker: () => {
        return llmLlamaLogitBiasConfigSchema;
    },
    effectiveEquals: (a, b) => {
        return deepEquals(a, b); // TODO: more performant comparison
    },
    stringify: value => {
        return JSON.stringify(value, null, 2); // TODO: pretty print
    },
})
    .valueType("llamaCacheQuantizationType", {
    paramType: {},
    schemaMaker: () => {
        return zod.z.object({
            checked: zod.z.boolean(),
            value: llmLlamaCacheQuantizationTypeSchema,
        });
    },
    effectiveEquals: (a, b) => {
        if (a.checked !== b.checked) {
            return false;
        }
        if (!a.checked) {
            return true;
        }
        return a.value === b.value;
    },
    stringify: (value, _typeParam, { t }) => {
        if (!value.checked) {
            return t("config:customInputs.llamaCacheQuantizationType.off", "OFF");
        }
        return value.value;
    },
})
    .valueType("mlxKvCacheQuantizationType", {
    paramType: {},
    schemaMaker: () => {
        return llmMlxKvCacheQuantizationSchema;
    },
    effectiveEquals: (a, b) => {
        if (a.enabled !== b.enabled) {
            return false;
        }
        if (!a.enabled) {
            return true;
        }
        return (a.bits === b.bits && a.groupSize === b.groupSize && a.quantizedStart === b.quantizedStart);
    },
    stringify: value => {
        return JSON.stringify(value, null, 2); // TODO: pretty print
    },
})
    .valueType("retrievalChunkingMethod", {
    paramType: {},
    schemaMaker: () => {
        return retrievalChunkingMethodSchema;
    },
    effectiveEquals: (a, b) => {
        return deepEquals(a, b); // TODO: more performant comparison
    },
    stringify: value => {
        return JSON.stringify(value, null, 2); // TODO: pretty print
    },
})
    .valueType("envVars", {
    paramType: {},
    schemaMaker: () => {
        return allowableEnvVarsSchema;
    },
    effectiveEquals: (a, b) => {
        return deepEquals(a, b);
    },
    stringify: value => {
        return JSON.stringify(value, null, 2);
    },
})
    .valueType("gpuSplitConfig", {
    paramType: {},
    schemaMaker: () => {
        return gpuSplitConfigSchema;
    },
    effectiveEquals: (a, b) => {
        return deepEquals(a, b);
    },
    stringify: value => {
        return JSON.stringify(value, null, 2);
    },
})
    .build();

/**
 * This file is divided into 4 sections:
 *
 * 1. globalConfigSchematics: The pool for all config keys and their types
 * 2. Functionality scope definitions: i.e. what config keys are available in what functionality
 *    scope. An example functionality scope is llmPrediction.
 * 3. Utility types that can be used to work with types of schema.
 */
// ---------------------------
//  1. globalConfigSchematics
// ---------------------------
const globalConfigSchematics = new KVConfigSchematicsBuilder(kvValueTypesLibrary)
    .extension("ext.virtualModel.customField")
    .field("envVars", "envVars", {}, {})
    .scope("llm.prediction", builder => builder
    .field("temperature", "numeric", {
    min: 0,
    step: 0.01,
    slider: { min: 0, max: 1, step: 0.01 },
    precision: 2,
    shortHand: "temp",
}, 0.8)
    .field("contextOverflowPolicy", "contextOverflowPolicy", {}, "truncateMiddle")
    .field("maxPredictedTokens", "checkboxNumeric", { min: 1, int: true }, { checked: false, value: 1000 })
    .field("stopStrings", "stringArray", {}, [])
    .field("toolCallStopStrings", "stringArray", {}, [])
    .field("structured", "llamaStructuredOutput", {}, { type: "none" })
    .scope("speculativeDecoding", builder => builder
    .field("draftModel", "speculativeDecodingDraftModel", {
    modelCentric: true,
}, "")
    .field("minDraftLengthToConsider", "numeric", {
    modelCentric: true,
    min: 0,
    int: true,
    slider: { min: 0, max: 10, step: 1 },
}, 0)
    .field("numReuseTokens", "numeric", { modelCentric: true, min: 1, int: true }, 256)
    .field("minContinueDraftingProbability", "numeric", {
    modelCentric: true,
    min: 0,
    max: 1,
    step: 0.01,
    precision: 2,
    slider: { min: 0, max: 1, step: 0.01 },
}, 0.75)
    .field("maxTokensToDraft", "numeric", { modelCentric: true, min: 1, int: true, slider: { min: 10, max: 30, step: 1 } }, 16)
    .field("numDraftTokensExact", "numeric", {
    modelCentric: true,
    min: 1,
    int: true,
    slider: { min: 1, max: 10, step: 1 },
}, 2))
    .field("tools", "toolUse", {}, { type: "none" })
    .field("toolNaming", "toolNaming", {}, "removeSpecial")
    .field("promptTemplate", "llmPromptTemplate", { modelCentric: true }, {
    type: "manual",
    manualPromptTemplate: {
        beforeSystem: "Instruct: ",
        afterSystem: "\n",
        beforeAssistant: "AI: ",
        afterAssistant: "\n",
        beforeUser: "Human: ",
        afterUser: "\n",
    },
    stopStrings: [],
})
    .field("systemPrompt", "string", { isParagraph: true }, "")
    .field("seed", "checkboxNumeric", { int: true, min: -1, uncheckedHint: "config:seedUncheckedHint" }, { checked: false, value: -1 })
    .field("contextPrefill", "context", {}, [])
    .field("topKSampling", "numeric", { min: -1, max: 500, int: true }, 40)
    .field("repeatPenalty", "checkboxNumeric", { min: -1, step: 0.01 }, { checked: true, value: 1.1 })
    .field("minPSampling", "checkboxNumeric", { min: 0, max: 1, step: 0.01, precision: 2, slider: { min: 0, max: 1, step: 0.01 } }, { checked: true, value: 0.05 })
    .field("topPSampling", "checkboxNumeric", { min: 0, max: 1, step: 0.01, precision: 2, slider: { min: 0, max: 1, step: 0.01 } }, { checked: true, value: 0.95 })
    .field("logProbs", "checkboxNumeric", { min: 0, max: 100, int: true }, { checked: false, value: 0 })
    .scope("reasoning", builder => builder.field("parsing", "llmReasoningParsing", {}, {
    enabled: true,
    startString: "<think>",
    endString: "</think>",
}))
    .scope("llama", builder => builder
    .field("cpuThreads", "numeric", { min: 1, int: true }, 4)
    .field("frequencyPenalty", "checkboxNumeric", { precision: 2 }, { checked: false, value: 0.0 })
    .field("xtcProbability", "checkboxNumeric", { min: 0, max: 1, step: 0.01, precision: 2, slider: { min: 0, max: 1, step: 0.01 } }, { checked: false, value: 0.5 })
    .field("xtcThreshold", "checkboxNumeric", { min: 0, max: 1, step: 0.01, precision: 2, slider: { min: 0, max: 0.5, step: 0.01 } }, { checked: false, value: 0.1 })
    .field("presencePenalty", "checkboxNumeric", { precision: 2 }, { checked: false, value: 0.0 })
    .field("mirostatSampling", "llamaMirostatSampling", {}, {
    // Disabled by default
    version: 0,
    learningRate: 0.1,
    targetEntropy: 5,
})
    .field("tailFreeSampling", "checkboxNumeric", { min: 0, max: 1, step: 0.01, precision: 2, slider: { min: 0, max: 1, step: 0.01 } }, { checked: false, value: 0.95 })
    .field("locallyTypicalSampling", "checkboxNumeric", { min: 0, max: 1, step: 0.01, precision: 2, slider: { min: 0, max: 1, step: 0.01 } }, { checked: false, value: 0.9 })
    .field("logitBias", "llamaLogitBias", {}, [])))
    .scope("llm.load", builder => builder
    .field("contextLength", "contextLength", {
    machineDependent: true,
}, 2048)
    .field("numExperts", "numeric", { min: 0, int: true }, 0)
    .field("seed", "checkboxNumeric", { int: true, min: -1, uncheckedHint: "config:seedUncheckedHint" }, { checked: false, value: -1 })
    .field("offloadKVCacheToGpu", "boolean", {}, true)
    .field("numCpuExpertLayersRatio", "llamaAccelerationOffloadRatio", { machineDependent: true, isExperimental: true, }, "off")
    .scope("llama", builder => builder
    .scope("acceleration", builder => builder.field("offloadRatio", "llamaAccelerationOffloadRatio", { machineDependent: true }, "max"))
    .field("cpuThreadPoolSize", "numeric", { min: 1, machineDependent: true }, 4)
    .field("evalBatchSize", "numeric", { min: 1, int: true }, 512)
    .field("flashAttention", "boolean", { isExperimental: true, warning: "config:flashAttentionWarning" }, false)
    .field("ropeFrequencyBase", "checkboxNumeric", { min: 0, uncheckedHint: "config:ropeFrequencyBaseUncheckedHint" }, { checked: false, value: 0 })
    .field("ropeFrequencyScale", "checkboxNumeric", { min: 0, uncheckedHint: "config:ropeFrequencyScaleUncheckedHint" }, { checked: false, value: 0 })
    .field("keepModelInMemory", "boolean", {}, true)
    .field("useFp16ForKVCache", "boolean", {}, true)
    .field("tryMmap", "boolean", {}, true)
    .field("kCacheQuantizationType", "llamaCacheQuantizationType", { isExperimental: true }, { checked: false, value: "f16" })
    .field("vCacheQuantizationType", "llamaCacheQuantizationType", { isExperimental: true, warning: "config:llamaKvCacheQuantizationWarning" }, { checked: false, value: "f16" }))
    .scope("mlx", builder => builder.field("kvCacheQuantization", "mlxKvCacheQuantizationType", { isExperimental: true }, { enabled: false, bits: 8, groupSize: 64, quantizedStart: 5000 })))
    .scope("load", builder => builder
    .field("gpuSplitConfig", "gpuSplitConfig", {}, defaultGPUSplitConfig)
    .field("gpuStrictVramCap", "boolean", {}, false))
    .scope("embedding.load", builder => builder
    .field("contextLength", "contextLength", { machineDependent: true }, 2048)
    .field("seed", "checkboxNumeric", { int: true, min: -1, uncheckedHint: "config:seedUncheckedHint" }, { checked: false, value: -1 })
    .scope("llama", builder => builder
    .scope("acceleration", builder => builder.field("offloadRatio", "llamaAccelerationOffloadRatio", { machineDependent: true }, "max"))
    .field("evalBatchSize", "numeric", { min: 1, int: true }, 512)
    .field("ropeFrequencyBase", "checkboxNumeric", { min: 0, uncheckedHint: "config:ropeFrequencyBaseUncheckedHint" }, { checked: false, value: 0 })
    .field("ropeFrequencyScale", "checkboxNumeric", { min: 0, uncheckedHint: "config:ropeFrequencyScaleUncheckedHint" }, { checked: false, value: 0 })
    .field("keepModelInMemory", "boolean", {}, true)
    .field("tryMmap", "boolean", {}, true)))
    .scope("retrieval", builder => builder
    .field("databaseFile", "string", { machineDependent: true }, "")
    .field("chunkingMethod", "retrievalChunkingMethod", {}, {
    type: "recursive-v1",
    chunkSize: 512,
    chunkOverlap: 100,
})
    .field("limit", "numeric", { min: 1, int: true }, 5)
    .field("embeddingModel", "modelIdentifier", { domain: ["embedding"] }, ""))
    .build();
// ------------------------------------
//  2. Functionality scope definitions
// ------------------------------------
const llmPredictionConfigSchematics = globalConfigSchematics.scoped("llm.prediction");
const llmSharedPredictionConfigSchematics = llmPredictionConfigSchematics.sliced("temperature", "maxPredictedTokens", "promptTemplate", "systemPrompt", "seed", "contextPrefill", "tools", "toolNaming", "reasoning.*");
llmSharedPredictionConfigSchematics.union(llmPredictionConfigSchematics.sliced("llama.*", "contextOverflowPolicy", "stopStrings", "toolCallStopStrings", "structured", "topKSampling", "repeatPenalty", "minPSampling", "topPSampling", "logProbs", "speculativeDecoding.draftModel", "speculativeDecoding.minContinueDraftingProbability", "speculativeDecoding.minDraftLengthToConsider", "speculativeDecoding.maxTokensToDraft", "speculativeDecoding.numReuseTokens"));
llmSharedPredictionConfigSchematics.union(llmPredictionConfigSchematics.sliced("mlx.*", "contextOverflowPolicy", "stopStrings", "toolCallStopStrings", "structured", "repeatPenalty", "minPSampling", "topPSampling", "topKSampling", "speculativeDecoding.draftModel", "speculativeDecoding.numDraftTokensExact"));
llmSharedPredictionConfigSchematics.union(llmPredictionConfigSchematics.sliced("transformers.*"));
llmSharedPredictionConfigSchematics.union(llmPredictionConfigSchematics.sliced("onnx.*", "repeatPenalty", "topPSampling", "topKSampling"));
const llmLoadSchematics = globalConfigSchematics
    .scoped("llm.load")
    .union(globalConfigSchematics.sliced("envVars"));
const llmSharedLoadConfigSchematics = llmLoadSchematics.sliced("contextLength", "seed", "envVars");
const llamaLoadConfigSchematics = globalConfigSchematics.sliced("llama.load.*", "load.*");
const llmLlamaLoadConfigSchematics = llmSharedLoadConfigSchematics
    .union(llmLoadSchematics.sliced("llama.*", "load.*", "offloadKVCacheToGpu"))
    .union(llamaLoadConfigSchematics);
llmSharedLoadConfigSchematics.union(llmLoadSchematics.sliced("mlx.*"));
llmSharedLoadConfigSchematics.union(llmLoadSchematics.sliced("transformers.*"));
llmSharedLoadConfigSchematics.union(llmLoadSchematics.sliced("onnx.*"));
const llmLlamaMoeAdditionalLoadConfigSchematics = llmLoadSchematics.sliced("numExperts", "numCpuExpertLayersRatio");
const llmLlamaMoeLoadConfigSchematics = llmLlamaLoadConfigSchematics.union(llmLlamaMoeAdditionalLoadConfigSchematics);
const embeddingLoadSchematics = globalConfigSchematics
    .scoped("embedding.load")
    .union(globalConfigSchematics.sliced("load.*"));
const embeddingSharedLoadConfigSchematics = embeddingLoadSchematics.sliced("contextLength", "seed");
const retrievalSchematics = globalConfigSchematics.scoped("retrieval");
const embeddingLlamaLoadConfigSchematics = embeddingSharedLoadConfigSchematics
    .union(embeddingLoadSchematics.sliced("llama.*"))
    .union(llamaLoadConfigSchematics);
new KVConfigSchematicsBuilder(kvValueTypesLibrary).build();

/**
 * Convert a number that can be false to checkbox numeric value.
 *
 * @param maybeFalseNumber - The value to translate.
 * @param valueWhenUnchecked - The value to use when the checkbox is unchecked.
 */
function maybeFalseNumberToCheckboxNumeric(maybeFalseNumber, valueWhenUnchecked) {
    if (maybeFalseNumber === undefined) {
        return undefined;
    }
    if (maybeFalseNumber === false) {
        return { checked: false, value: valueWhenUnchecked };
    }
    return { checked: true, value: maybeFalseNumber };
}

function llmPredictionConfigToKVConfig(config) {
    const top = llmPredictionConfigSchematics.buildPartialConfig({
        "temperature": config.temperature,
        "contextOverflowPolicy": config.contextOverflowPolicy,
        "maxPredictedTokens": maybeFalseNumberToCheckboxNumeric(config.maxTokens, 1),
        "stopStrings": config.stopStrings,
        "toolCallStopStrings": config.toolCallStopStrings,
        "structured": config.structured,
        "tools": config.rawTools,
        "toolNaming": config.toolNaming,
        "topKSampling": config.topKSampling,
        "repeatPenalty": maybeFalseNumberToCheckboxNumeric(config.repeatPenalty, 1.1),
        "minPSampling": maybeFalseNumberToCheckboxNumeric(config.minPSampling, 0.05),
        "topPSampling": maybeFalseNumberToCheckboxNumeric(config.topPSampling, 0.95),
        "llama.xtcProbability": maybeFalseNumberToCheckboxNumeric(config.xtcProbability, 0),
        "llama.xtcThreshold": maybeFalseNumberToCheckboxNumeric(config.xtcThreshold, 0),
        "logProbs": maybeFalseNumberToCheckboxNumeric(config.logProbs, 0),
        "llama.cpuThreads": config.cpuThreads,
        "promptTemplate": config.promptTemplate,
        "speculativeDecoding.draftModel": config.draftModel,
        "speculativeDecoding.numDraftTokensExact": config.speculativeDecodingNumDraftTokensExact,
        "speculativeDecoding.minDraftLengthToConsider": config.speculativeDecodingMinDraftLengthToConsider,
        "speculativeDecoding.minContinueDraftingProbability": config.speculativeDecodingMinContinueDraftingProbability,
        "reasoning.parsing": config.reasoningParsing,
    });
    if (config.raw !== undefined) {
        return collapseKVStackRaw([config.raw, top]);
    }
    return top;
}

/**
 * @public
 */
function createConfigSchematics() {
    return new KVConfigSchematicsBuilder(kvValueTypesLibrary);
}

var lib = {};

var helpers = {};

var hasRequiredHelpers;

function requireHelpers () {
	if (hasRequiredHelpers) return helpers;
	hasRequiredHelpers = 1;

	var ValidationError = helpers.ValidationError = function ValidationError (message, instance, schema, path, name, argument) {
	  if(Array.isArray(path)){
	    this.path = path;
	    this.property = path.reduce(function(sum, item){
	      return sum + makeSuffix(item);
	    }, 'instance');
	  }else if(path !== undefined){
	    this.property = path;
	  }
	  if (message) {
	    this.message = message;
	  }
	  if (schema) {
	    var id = schema.$id || schema.id;
	    this.schema = id || schema;
	  }
	  if (instance !== undefined) {
	    this.instance = instance;
	  }
	  this.name = name;
	  this.argument = argument;
	  this.stack = this.toString();
	};

	ValidationError.prototype.toString = function toString() {
	  return this.property + ' ' + this.message;
	};

	var ValidatorResult = helpers.ValidatorResult = function ValidatorResult(instance, schema, options, ctx) {
	  this.instance = instance;
	  this.schema = schema;
	  this.options = options;
	  this.path = ctx.path;
	  this.propertyPath = ctx.propertyPath;
	  this.errors = [];
	  this.throwError = options && options.throwError;
	  this.throwFirst = options && options.throwFirst;
	  this.throwAll = options && options.throwAll;
	  this.disableFormat = options && options.disableFormat === true;
	};

	ValidatorResult.prototype.addError = function addError(detail) {
	  var err;
	  if (typeof detail == 'string') {
	    err = new ValidationError(detail, this.instance, this.schema, this.path);
	  } else {
	    if (!detail) throw new Error('Missing error detail');
	    if (!detail.message) throw new Error('Missing error message');
	    if (!detail.name) throw new Error('Missing validator type');
	    err = new ValidationError(detail.message, this.instance, this.schema, this.path, detail.name, detail.argument);
	  }

	  this.errors.push(err);
	  if (this.throwFirst) {
	    throw new ValidatorResultError(this);
	  }else if(this.throwError){
	    throw err;
	  }
	  return err;
	};

	ValidatorResult.prototype.importErrors = function importErrors(res) {
	  if (typeof res == 'string' || (res && res.validatorType)) {
	    this.addError(res);
	  } else if (res && res.errors) {
	    this.errors = this.errors.concat(res.errors);
	  }
	};

	function stringizer (v,i){
	  return i+': '+v.toString()+'\n';
	}
	ValidatorResult.prototype.toString = function toString(res) {
	  return this.errors.map(stringizer).join('');
	};

	Object.defineProperty(ValidatorResult.prototype, "valid", { get: function() {
	  return !this.errors.length;
	} });

	helpers.ValidatorResultError = ValidatorResultError;
	function ValidatorResultError(result) {
	  if(typeof Error.captureStackTrace === 'function'){
	    Error.captureStackTrace(this, ValidatorResultError);
	  }
	  this.instance = result.instance;
	  this.schema = result.schema;
	  this.options = result.options;
	  this.errors = result.errors;
	}
	ValidatorResultError.prototype = new Error();
	ValidatorResultError.prototype.constructor = ValidatorResultError;
	ValidatorResultError.prototype.name = "Validation Error";

	/**
	 * Describes a problem with a Schema which prevents validation of an instance
	 * @name SchemaError
	 * @constructor
	 */
	var SchemaError = helpers.SchemaError = function SchemaError (msg, schema) {
	  this.message = msg;
	  this.schema = schema;
	  Error.call(this, msg);
	  if(typeof Error.captureStackTrace === 'function'){
	    Error.captureStackTrace(this, SchemaError);
	  }
	};
	SchemaError.prototype = Object.create(Error.prototype,
	  {
	    constructor: {value: SchemaError, enumerable: false},
	    name: {value: 'SchemaError', enumerable: false},
	  });

	var SchemaContext = helpers.SchemaContext = function SchemaContext (schema, options, path, base, schemas) {
	  this.schema = schema;
	  this.options = options;
	  if(Array.isArray(path)){
	    this.path = path;
	    this.propertyPath = path.reduce(function(sum, item){
	      return sum + makeSuffix(item);
	    }, 'instance');
	  }else {
	    this.propertyPath = path;
	  }
	  this.base = base;
	  this.schemas = schemas;
	};

	SchemaContext.prototype.resolve = function resolve (target) {
	  return (() => resolveUrl(this.base,target))();
	};

	SchemaContext.prototype.makeChild = function makeChild(schema, propertyName){
	  var path = (propertyName===undefined) ? this.path : this.path.concat([propertyName]);
	  var id = schema.$id || schema.id;
	  let base = (() => resolveUrl(this.base,id||''))();
	  var ctx = new SchemaContext(schema, this.options, path, base, Object.create(this.schemas));
	  if(id && !ctx.schemas[base]){
	    ctx.schemas[base] = schema;
	  }
	  return ctx;
	};

	var FORMAT_REGEXPS = helpers.FORMAT_REGEXPS = {
	  // 7.3.1. Dates, Times, and Duration
	  'date-time': /^\d{4}-(?:0[0-9]{1}|1[0-2]{1})-(3[01]|0[1-9]|[12][0-9])[tT ](2[0-4]|[01][0-9]):([0-5][0-9]):(60|[0-5][0-9])(\.\d+)?([zZ]|[+-]([0-5][0-9]):(60|[0-5][0-9]))$/,
	  'date': /^\d{4}-(?:0[0-9]{1}|1[0-2]{1})-(3[01]|0[1-9]|[12][0-9])$/,
	  'time': /^(2[0-4]|[01][0-9]):([0-5][0-9]):(60|[0-5][0-9])$/,
	  'duration': /P(T\d+(H(\d+M(\d+S)?)?|M(\d+S)?|S)|\d+(D|M(\d+D)?|Y(\d+M(\d+D)?)?)(T\d+(H(\d+M(\d+S)?)?|M(\d+S)?|S))?|\d+W)/i,

	  // 7.3.2. Email Addresses
	  // TODO: fix the email production
	  'email': /^(?:[\w\!\#\$\%\&\'\*\+\-\/\=\?\^\`\{\|\}\~]+\.)*[\w\!\#\$\%\&\'\*\+\-\/\=\?\^\`\{\|\}\~]+@(?:(?:(?:[a-zA-Z0-9](?:[a-zA-Z0-9\-](?!\.)){0,61}[a-zA-Z0-9]?\.)+[a-zA-Z0-9](?:[a-zA-Z0-9\-](?!$)){0,61}[a-zA-Z0-9]?)|(?:\[(?:(?:[01]?\d{1,2}|2[0-4]\d|25[0-5])\.){3}(?:[01]?\d{1,2}|2[0-4]\d|25[0-5])\]))$/,
	  'idn-email': /^("(?:[!#-\[\]-\u{10FFFF}]|\\[\t -\u{10FFFF}])*"|[!#-'*+\-/-9=?A-Z\^-\u{10FFFF}](?:\.?[!#-'*+\-/-9=?A-Z\^-\u{10FFFF}])*)@([!#-'*+\-/-9=?A-Z\^-\u{10FFFF}](?:\.?[!#-'*+\-/-9=?A-Z\^-\u{10FFFF}])*|\[[!-Z\^-\u{10FFFF}]*\])$/u,

	  // 7.3.3. Hostnames

	  // 7.3.4. IP Addresses
	  'ip-address': /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/,
	  // FIXME whitespace is invalid
	  'ipv6': /^\s*((([0-9A-Fa-f]{1,4}:){7}([0-9A-Fa-f]{1,4}|:))|(([0-9A-Fa-f]{1,4}:){6}(:[0-9A-Fa-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9A-Fa-f]{1,4}:){5}(((:[0-9A-Fa-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9A-Fa-f]{1,4}:){4}(((:[0-9A-Fa-f]{1,4}){1,3})|((:[0-9A-Fa-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){3}(((:[0-9A-Fa-f]{1,4}){1,4})|((:[0-9A-Fa-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){2}(((:[0-9A-Fa-f]{1,4}){1,5})|((:[0-9A-Fa-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){1}(((:[0-9A-Fa-f]{1,4}){1,6})|((:[0-9A-Fa-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9A-Fa-f]{1,4}){1,7})|((:[0-9A-Fa-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))(%.+)?\s*$/,

	  // 7.3.5. Resource Identifiers
	  // TODO: A more accurate regular expression for "uri" goes:
	  // [A-Za-z][+\-.0-9A-Za-z]*:((/(/((%[0-9A-Fa-f]{2}|[!$&-.0-9;=A-Z_a-z~])+|(\[(([Vv][0-9A-Fa-f]+\.[!$&-.0-;=A-Z_a-z~]+)?|[.0-:A-Fa-f]+)\])?)(:\d*)?)?)?#(%[0-9A-Fa-f]{2}|[!$&-;=?-Z_a-z~])*|(/(/((%[0-9A-Fa-f]{2}|[!$&-.0-9;=A-Z_a-z~])+|(\[(([Vv][0-9A-Fa-f]+\.[!$&-.0-;=A-Z_a-z~]+)?|[.0-:A-Fa-f]+)\])?)(:\d*)?[/?]|[!$&-.0-;=?-Z_a-z~])|/?%[0-9A-Fa-f]{2}|[!$&-.0-;=?-Z_a-z~])(%[0-9A-Fa-f]{2}|[!$&-;=?-Z_a-z~])*(#(%[0-9A-Fa-f]{2}|[!$&-;=?-Z_a-z~])*)?|/(/((%[0-9A-Fa-f]{2}|[!$&-.0-9;=A-Z_a-z~])+(:\d*)?|(\[(([Vv][0-9A-Fa-f]+\.[!$&-.0-;=A-Z_a-z~]+)?|[.0-:A-Fa-f]+)\])?:\d*|\[(([Vv][0-9A-Fa-f]+\.[!$&-.0-;=A-Z_a-z~]+)?|[.0-:A-Fa-f]+)\])?)?)?
	  'uri': /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s]*$/,
	  'uri-reference': /^(((([A-Za-z][+\-.0-9A-Za-z]*(:%[0-9A-Fa-f]{2}|:[!$&-.0-;=?-Z_a-z~]|[/?])|\?)(%[0-9A-Fa-f]{2}|[!$&-;=?-Z_a-z~])*|([A-Za-z][+\-.0-9A-Za-z]*:?)?)|([A-Za-z][+\-.0-9A-Za-z]*:)?\/((%[0-9A-Fa-f]{2}|\/((%[0-9A-Fa-f]{2}|[!$&-.0-9;=A-Z_a-z~])+|(\[(([Vv][0-9A-Fa-f]+\.[!$&-.0-;=A-Z_a-z~]+)?|[.0-:A-Fa-f]+)\])?)(:\d*)?[/?]|[!$&-.0-;=?-Z_a-z~])(%[0-9A-Fa-f]{2}|[!$&-;=?-Z_a-z~])*|(\/((%[0-9A-Fa-f]{2}|[!$&-.0-9;=A-Z_a-z~])+|(\[(([Vv][0-9A-Fa-f]+\.[!$&-.0-;=A-Z_a-z~]+)?|[.0-:A-Fa-f]+)\])?)(:\d*)?)?))#(%[0-9A-Fa-f]{2}|[!$&-;=?-Z_a-z~])*|(([A-Za-z][+\-.0-9A-Za-z]*)?%[0-9A-Fa-f]{2}|[!$&-.0-9;=@_~]|[A-Za-z][+\-.0-9A-Za-z]*[!$&-*,;=@_~])(%[0-9A-Fa-f]{2}|[!$&-.0-9;=@-Z_a-z~])*((([/?](%[0-9A-Fa-f]{2}|[!$&-;=?-Z_a-z~])*)?#|[/?])(%[0-9A-Fa-f]{2}|[!$&-;=?-Z_a-z~])*)?|([A-Za-z][+\-.0-9A-Za-z]*(:%[0-9A-Fa-f]{2}|:[!$&-.0-;=?-Z_a-z~]|[/?])|\?)(%[0-9A-Fa-f]{2}|[!$&-;=?-Z_a-z~])*|([A-Za-z][+\-.0-9A-Za-z]*:)?\/((%[0-9A-Fa-f]{2}|\/((%[0-9A-Fa-f]{2}|[!$&-.0-9;=A-Z_a-z~])+|(\[(([Vv][0-9A-Fa-f]+\.[!$&-.0-;=A-Z_a-z~]+)?|[.0-:A-Fa-f]+)\])?)(:\d*)?[/?]|[!$&-.0-;=?-Z_a-z~])(%[0-9A-Fa-f]{2}|[!$&-;=?-Z_a-z~])*|\/((%[0-9A-Fa-f]{2}|[!$&-.0-9;=A-Z_a-z~])+(:\d*)?|(\[(([Vv][0-9A-Fa-f]+\.[!$&-.0-;=A-Z_a-z~]+)?|[.0-:A-Fa-f]+)\])?:\d*|\[(([Vv][0-9A-Fa-f]+\.[!$&-.0-;=A-Z_a-z~]+)?|[.0-:A-Fa-f]+)\])?)?|[A-Za-z][+\-.0-9A-Za-z]*:?)?$/,
	  'iri': /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s]*$/,
	  'iri-reference': /^(((([A-Za-z][+\-.0-9A-Za-z]*(:%[0-9A-Fa-f]{2}|:[!$&-.0-;=?-Z_a-z~-\u{10FFFF}]|[/?])|\?)(%[0-9A-Fa-f]{2}|[!$&-;=?-Z_a-z~-\u{10FFFF}])*|([A-Za-z][+\-.0-9A-Za-z]*:?)?)|([A-Za-z][+\-.0-9A-Za-z]*:)?\/((%[0-9A-Fa-f]{2}|\/((%[0-9A-Fa-f]{2}|[!$&-.0-9;=A-Z_a-z~-\u{10FFFF}])+|(\[(([Vv][0-9A-Fa-f]+\.[!$&-.0-;=A-Z_a-z~-\u{10FFFF}]+)?|[.0-:A-Fa-f]+)\])?)(:\d*)?[/?]|[!$&-.0-;=?-Z_a-z~-\u{10FFFF}])(%[0-9A-Fa-f]{2}|[!$&-;=?-Z_a-z~-\u{10FFFF}])*|(\/((%[0-9A-Fa-f]{2}|[!$&-.0-9;=A-Z_a-z~-\u{10FFFF}])+|(\[(([Vv][0-9A-Fa-f]+\.[!$&-.0-;=A-Z_a-z~-\u{10FFFF}]+)?|[.0-:A-Fa-f]+)\])?)(:\d*)?)?))#(%[0-9A-Fa-f]{2}|[!$&-;=?-Z_a-z~-\u{10FFFF}])*|(([A-Za-z][+\-.0-9A-Za-z]*)?%[0-9A-Fa-f]{2}|[!$&-.0-9;=@_~-\u{10FFFF}]|[A-Za-z][+\-.0-9A-Za-z]*[!$&-*,;=@_~-\u{10FFFF}])(%[0-9A-Fa-f]{2}|[!$&-.0-9;=@-Z_a-z~-\u{10FFFF}])*((([/?](%[0-9A-Fa-f]{2}|[!$&-;=?-Z_a-z~-\u{10FFFF}])*)?#|[/?])(%[0-9A-Fa-f]{2}|[!$&-;=?-Z_a-z~-\u{10FFFF}])*)?|([A-Za-z][+\-.0-9A-Za-z]*(:%[0-9A-Fa-f]{2}|:[!$&-.0-;=?-Z_a-z~-\u{10FFFF}]|[/?])|\?)(%[0-9A-Fa-f]{2}|[!$&-;=?-Z_a-z~-\u{10FFFF}])*|([A-Za-z][+\-.0-9A-Za-z]*:)?\/((%[0-9A-Fa-f]{2}|\/((%[0-9A-Fa-f]{2}|[!$&-.0-9;=A-Z_a-z~-\u{10FFFF}])+|(\[(([Vv][0-9A-Fa-f]+\.[!$&-.0-;=A-Z_a-z~-\u{10FFFF}]+)?|[.0-:A-Fa-f]+)\])?)(:\d*)?[/?]|[!$&-.0-;=?-Z_a-z~-\u{10FFFF}])(%[0-9A-Fa-f]{2}|[!$&-;=?-Z_a-z~-\u{10FFFF}])*|\/((%[0-9A-Fa-f]{2}|[!$&-.0-9;=A-Z_a-z~-\u{10FFFF}])+(:\d*)?|(\[(([Vv][0-9A-Fa-f]+\.[!$&-.0-;=A-Z_a-z~-\u{10FFFF}]+)?|[.0-:A-Fa-f]+)\])?:\d*|\[(([Vv][0-9A-Fa-f]+\.[!$&-.0-;=A-Z_a-z~-\u{10FFFF}]+)?|[.0-:A-Fa-f]+)\])?)?|[A-Za-z][+\-.0-9A-Za-z]*:?)?$/u,
	  'uuid': /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i,

	  // 7.3.6. uri-template
	  'uri-template': /(%[0-9a-f]{2}|[!#$&(-;=?@\[\]_a-z~]|\{[!#&+,./;=?@|]?(%[0-9a-f]{2}|[0-9_a-z])(\.?(%[0-9a-f]{2}|[0-9_a-z]))*(:[1-9]\d{0,3}|\*)?(,(%[0-9a-f]{2}|[0-9_a-z])(\.?(%[0-9a-f]{2}|[0-9_a-z]))*(:[1-9]\d{0,3}|\*)?)*\})*/iu,

	  // 7.3.7. JSON Pointers
	  'json-pointer': /^(\/([\x00-\x2e0-@\[-}\x7f]|~[01])*)*$/iu,
	  'relative-json-pointer': /^\d+(#|(\/([\x00-\x2e0-@\[-}\x7f]|~[01])*)*)$/iu,

	  // hostname regex from: http://stackoverflow.com/a/1420225/5628
	  'hostname': /^(?=.{1,255}$)[0-9A-Za-z](?:(?:[0-9A-Za-z]|-){0,61}[0-9A-Za-z])?(?:\.[0-9A-Za-z](?:(?:[0-9A-Za-z]|-){0,61}[0-9A-Za-z])?)*\.?$/,
	  'host-name': /^(?=.{1,255}$)[0-9A-Za-z](?:(?:[0-9A-Za-z]|-){0,61}[0-9A-Za-z])?(?:\.[0-9A-Za-z](?:(?:[0-9A-Za-z]|-){0,61}[0-9A-Za-z])?)*\.?$/,

	  'utc-millisec': function (input) {
	    return (typeof input === 'string') && parseFloat(input) === parseInt(input, 10) && !isNaN(input);
	  },

	  // 7.3.8. regex
	  'regex': function (input) {
	    var result = true;
	    try {
	      new RegExp(input);
	    } catch (e) {
	      result = false;
	    }
	    return result;
	  },

	  // Other definitions
	  // "style" was removed from JSON Schema in draft-4 and is deprecated
	  'style': /[\r\n\t ]*[^\r\n\t ][^:]*:[\r\n\t ]*[^\r\n\t ;]*[\r\n\t ]*;?/,
	  // "color" was removed from JSON Schema in draft-4 and is deprecated
	  'color': /^(#?([0-9A-Fa-f]{3}){1,2}\b|aqua|black|blue|fuchsia|gray|green|lime|maroon|navy|olive|orange|purple|red|silver|teal|white|yellow|(rgb\(\s*\b([0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])\b\s*,\s*\b([0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])\b\s*,\s*\b([0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])\b\s*\))|(rgb\(\s*(\d?\d%|100%)+\s*,\s*(\d?\d%|100%)+\s*,\s*(\d?\d%|100%)+\s*\)))$/,
	  'phone': /^\+(?:[0-9] ?){6,14}[0-9]$/,
	  'alpha': /^[a-zA-Z]+$/,
	  'alphanumeric': /^[a-zA-Z0-9]+$/,
	};

	FORMAT_REGEXPS.regexp = FORMAT_REGEXPS.regex;
	FORMAT_REGEXPS.pattern = FORMAT_REGEXPS.regex;
	FORMAT_REGEXPS.ipv4 = FORMAT_REGEXPS['ip-address'];

	helpers.isFormat = function isFormat (input, format, validator) {
	  if (typeof input === 'string' && FORMAT_REGEXPS[format] !== undefined) {
	    if (FORMAT_REGEXPS[format] instanceof RegExp) {
	      return FORMAT_REGEXPS[format].test(input);
	    }
	    if (typeof FORMAT_REGEXPS[format] === 'function') {
	      return FORMAT_REGEXPS[format](input);
	    }
	  } else if (validator && validator.customFormats &&
	      typeof validator.customFormats[format] === 'function') {
	    return validator.customFormats[format](input);
	  }
	  return true;
	};

	var makeSuffix = helpers.makeSuffix = function makeSuffix (key) {
	  key = key.toString();
	  // This function could be capable of outputting valid a ECMAScript string, but the
	  // resulting code for testing which form to use would be tens of thousands of characters long
	  // That means this will use the name form for some illegal forms
	  if (!key.match(/[.\s\[\]]/) && !key.match(/^[\d]/)) {
	    return '.' + key;
	  }
	  if (key.match(/^\d+$/)) {
	    return '[' + key + ']';
	  }
	  return '[' + JSON.stringify(key) + ']';
	};

	helpers.deepCompareStrict = function deepCompareStrict (a, b) {
	  if (typeof a !== typeof b) {
	    return false;
	  }
	  if (Array.isArray(a)) {
	    if (!Array.isArray(b)) {
	      return false;
	    }
	    if (a.length !== b.length) {
	      return false;
	    }
	    return a.every(function (v, i) {
	      return deepCompareStrict(a[i], b[i]);
	    });
	  }
	  if (typeof a === 'object') {
	    if (!a || !b) {
	      return a === b;
	    }
	    var aKeys = Object.keys(a);
	    var bKeys = Object.keys(b);
	    if (aKeys.length !== bKeys.length) {
	      return false;
	    }
	    return aKeys.every(function (v) {
	      return deepCompareStrict(a[v], b[v]);
	    });
	  }
	  return a === b;
	};

	function deepMerger (target, dst, e, i) {
	  if (typeof e === 'object') {
	    dst[i] = deepMerge(target[i], e);
	  } else {
	    if (target.indexOf(e) === -1) {
	      dst.push(e);
	    }
	  }
	}

	function copyist (src, dst, key) {
	  dst[key] = src[key];
	}

	function copyistWithDeepMerge (target, src, dst, key) {
	  if (typeof src[key] !== 'object' || !src[key]) {
	    dst[key] = src[key];
	  }
	  else {
	    if (!target[key]) {
	      dst[key] = src[key];
	    } else {
	      dst[key] = deepMerge(target[key], src[key]);
	    }
	  }
	}

	function deepMerge (target, src) {
	  var array = Array.isArray(src);
	  var dst = array && [] || {};

	  if (array) {
	    target = target || [];
	    dst = dst.concat(target);
	    src.forEach(deepMerger.bind(null, target, dst));
	  } else {
	    if (target && typeof target === 'object') {
	      Object.keys(target).forEach(copyist.bind(null, target, dst));
	    }
	    Object.keys(src).forEach(copyistWithDeepMerge.bind(null, target, src, dst));
	  }

	  return dst;
	}

	helpers.deepMerge = deepMerge;

	/**
	 * Validates instance against the provided schema
	 * Implements URI+JSON Pointer encoding, e.g. "%7e"="~0"=>"~", "~1"="%2f"=>"/"
	 * @param o
	 * @param s The path to walk o along
	 * @return any
	 */
	helpers.objectGetPath = function objectGetPath(o, s) {
	  var parts = s.split('/').slice(1);
	  var k;
	  while (typeof (k=parts.shift()) == 'string') {
	    var n = decodeURIComponent(k.replace(/~0/,'~').replace(/~1/g,'/'));
	    if (!(n in o)) return;
	    o = o[n];
	  }
	  return o;
	};

	function pathEncoder (v) {
	  return '/'+encodeURIComponent(v).replace(/~/g,'%7E');
	}
	/**
	 * Accept an Array of property names and return a JSON Pointer URI fragment
	 * @param Array a
	 * @return {String}
	 */
	helpers.encodePath = function encodePointer(a){
	  // ~ must be encoded explicitly because hacks
	  // the slash is encoded by encodeURIComponent
	  return a.map(pathEncoder).join('');
	};


	/**
	 * Calculate the number of decimal places a number uses
	 * We need this to get correct results out of multipleOf and divisibleBy
	 * when either figure is has decimal places, due to IEEE-754 float issues.
	 * @param number
	 * @returns {number}
	 */
	helpers.getDecimalPlaces = function getDecimalPlaces(number) {

	  var decimalPlaces = 0;
	  if (isNaN(number)) return decimalPlaces;

	  if (typeof number !== 'number') {
	    number = Number(number);
	  }

	  var parts = number.toString().split('e');
	  if (parts.length === 2) {
	    if (parts[1][0] !== '-') {
	      return decimalPlaces;
	    } else {
	      decimalPlaces = Number(parts[1].slice(1));
	    }
	  }

	  var decimalParts = parts[0].split('.');
	  if (decimalParts.length === 2) {
	    decimalPlaces += decimalParts[1].length;
	  }

	  return decimalPlaces;
	};

	helpers.isSchema = function isSchema(val){
	  return (typeof val === 'object' && val) || (typeof val === 'boolean');
	};

	/**
	 * Resolve target URL from a base and relative URL.
	 * Similar to Node's URL Lib's legacy resolve function.
	 * Code from example in deprecation note in said library.
	 * @param string
	 * @param string
	 * @returns {string}
	 */
	var resolveUrl = helpers.resolveUrl = function resolveUrl(from, to) {
	  const resolvedUrl = new URL(to, new URL(from, 'resolve://'));
	  if (resolvedUrl.protocol === 'resolve:') {
	    const { pathname, search, hash } = resolvedUrl;
	    return pathname + search + hash;
	  }
	  return resolvedUrl.toString();
	};
	return helpers;
}

var attribute_1;
var hasRequiredAttribute;

function requireAttribute () {
	if (hasRequiredAttribute) return attribute_1;
	hasRequiredAttribute = 1;

	var helpers = requireHelpers();

	/** @type ValidatorResult */
	var ValidatorResult = helpers.ValidatorResult;
	/** @type SchemaError */
	var SchemaError = helpers.SchemaError;

	var attribute = {};

	attribute.ignoreProperties = {
	  // informative properties
	  'id': true,
	  'default': true,
	  'description': true,
	  'title': true,
	  // arguments to other properties
	  'additionalItems': true,
	  'then': true,
	  'else': true,
	  // special-handled properties
	  '$schema': true,
	  '$ref': true,
	  'extends': true,
	};

	/**
	 * @name validators
	 */
	var validators = attribute.validators = {};

	/**
	 * Validates whether the instance if of a certain type
	 * @param instance
	 * @param schema
	 * @param options
	 * @param ctx
	 * @return {ValidatorResult|null}
	 */
	validators.type = function validateType (instance, schema, options, ctx) {
	  // Ignore undefined instances
	  if (instance === undefined) {
	    return null;
	  }
	  var result = new ValidatorResult(instance, schema, options, ctx);
	  var types = Array.isArray(schema.type) ? schema.type : [schema.type];
	  if (!types.some(this.testType.bind(this, instance, schema, options, ctx))) {
	    var list = types.map(function (v) {
	      if(!v) return;
	      var id = v.$id || v.id;
	      return id ? ('<' + id + '>') : (v+'');
	    });
	    result.addError({
	      name: 'type',
	      argument: list,
	      message: "is not of a type(s) " + list,
	    });
	  }
	  return result;
	};

	function testSchemaNoThrow(instance, options, ctx, callback, schema){
	  var throwError = options.throwError;
	  var throwAll = options.throwAll;
	  options.throwError = false;
	  options.throwAll = false;
	  var res = this.validateSchema(instance, schema, options, ctx);
	  options.throwError = throwError;
	  options.throwAll = throwAll;

	  if (!res.valid && callback instanceof Function) {
	    callback(res);
	  }
	  return res.valid;
	}

	/**
	 * Validates whether the instance matches some of the given schemas
	 * @param instance
	 * @param schema
	 * @param options
	 * @param ctx
	 * @return {ValidatorResult|null}
	 */
	validators.anyOf = function validateAnyOf (instance, schema, options, ctx) {
	  // Ignore undefined instances
	  if (instance === undefined) {
	    return null;
	  }
	  var result = new ValidatorResult(instance, schema, options, ctx);
	  var inner = new ValidatorResult(instance, schema, options, ctx);
	  if (!Array.isArray(schema.anyOf)){
	    throw new SchemaError("anyOf must be an array");
	  }
	  if (!schema.anyOf.some(
	    testSchemaNoThrow.bind(
	      this, instance, options, ctx, function(res){inner.importErrors(res);}
	    ))) {
	    var list = schema.anyOf.map(function (v, i) {
	      var id = v.$id || v.id;
	      if(id) return '<' + id + '>';
	      return (v.title && JSON.stringify(v.title)) || (v['$ref'] && ('<' + v['$ref'] + '>')) || '[subschema '+i+']';
	    });
	    if (options.nestedErrors) {
	      result.importErrors(inner);
	    }
	    result.addError({
	      name: 'anyOf',
	      argument: list,
	      message: "is not any of " + list.join(','),
	    });
	  }
	  return result;
	};

	/**
	 * Validates whether the instance matches every given schema
	 * @param instance
	 * @param schema
	 * @param options
	 * @param ctx
	 * @return {String|null}
	 */
	validators.allOf = function validateAllOf (instance, schema, options, ctx) {
	  // Ignore undefined instances
	  if (instance === undefined) {
	    return null;
	  }
	  if (!Array.isArray(schema.allOf)){
	    throw new SchemaError("allOf must be an array");
	  }
	  var result = new ValidatorResult(instance, schema, options, ctx);
	  var self = this;
	  schema.allOf.forEach(function(v, i){
	    var valid = self.validateSchema(instance, v, options, ctx);
	    if(!valid.valid){
	      var id = v.$id || v.id;
	      var msg = id || (v.title && JSON.stringify(v.title)) || (v['$ref'] && ('<' + v['$ref'] + '>')) || '[subschema '+i+']';
	      result.addError({
	        name: 'allOf',
	        argument: { id: msg, length: valid.errors.length, valid: valid },
	        message: 'does not match allOf schema ' + msg + ' with ' + valid.errors.length + ' error[s]:',
	      });
	      result.importErrors(valid);
	    }
	  });
	  return result;
	};

	/**
	 * Validates whether the instance matches exactly one of the given schemas
	 * @param instance
	 * @param schema
	 * @param options
	 * @param ctx
	 * @return {String|null}
	 */
	validators.oneOf = function validateOneOf (instance, schema, options, ctx) {
	  // Ignore undefined instances
	  if (instance === undefined) {
	    return null;
	  }
	  if (!Array.isArray(schema.oneOf)){
	    throw new SchemaError("oneOf must be an array");
	  }
	  var result = new ValidatorResult(instance, schema, options, ctx);
	  var inner = new ValidatorResult(instance, schema, options, ctx);
	  var count = schema.oneOf.filter(
	    testSchemaNoThrow.bind(
	      this, instance, options, ctx, function(res) {inner.importErrors(res);}
	    ) ).length;
	  var list = schema.oneOf.map(function (v, i) {
	    var id = v.$id || v.id;
	    return id || (v.title && JSON.stringify(v.title)) || (v['$ref'] && ('<' + v['$ref'] + '>')) || '[subschema '+i+']';
	  });
	  if (count!==1) {
	    if (options.nestedErrors) {
	      result.importErrors(inner);
	    }
	    result.addError({
	      name: 'oneOf',
	      argument: list,
	      message: "is not exactly one from " + list.join(','),
	    });
	  }
	  return result;
	};

	/**
	 * Validates "then" or "else" depending on the result of validating "if"
	 * @param instance
	 * @param schema
	 * @param options
	 * @param ctx
	 * @return {String|null}
	 */
	validators.if = function validateIf (instance, schema, options, ctx) {
	  // Ignore undefined instances
	  if (instance === undefined) return null;
	  if (!helpers.isSchema(schema.if)) throw new Error('Expected "if" keyword to be a schema');
	  var ifValid = testSchemaNoThrow.call(this, instance, options, ctx, null, schema.if);
	  var result = new ValidatorResult(instance, schema, options, ctx);
	  var res;
	  if(ifValid){
	    if (schema.then === undefined) return;
	    if (!helpers.isSchema(schema.then)) throw new Error('Expected "then" keyword to be a schema');
	    res = this.validateSchema(instance, schema.then, options, ctx.makeChild(schema.then));
	    result.importErrors(res);
	  }else {
	    if (schema.else === undefined) return;
	    if (!helpers.isSchema(schema.else)) throw new Error('Expected "else" keyword to be a schema');
	    res = this.validateSchema(instance, schema.else, options, ctx.makeChild(schema.else));
	    result.importErrors(res);
	  }
	  return result;
	};

	function getEnumerableProperty(object, key){
	  // Determine if `key` shows up in `for(var key in object)`
	  // First test Object.hasOwnProperty.call as an optimization: that guarantees it does
	  if(Object.hasOwnProperty.call(object, key)) return object[key];
	  // Test `key in object` as an optimization; false means it won't
	  if(!(key in object)) return;
	  while( (object = Object.getPrototypeOf(object)) ){
	    if(Object.propertyIsEnumerable.call(object, key)) return object[key];
	  }
	}

	/**
	 * Validates propertyNames
	 * @param instance
	 * @param schema
	 * @param options
	 * @param ctx
	 * @return {String|null|ValidatorResult}
	 */
	validators.propertyNames = function validatePropertyNames (instance, schema, options, ctx) {
	  if(!this.types.object(instance)) return;
	  var result = new ValidatorResult(instance, schema, options, ctx);
	  var subschema = schema.propertyNames!==undefined ? schema.propertyNames : {};
	  if(!helpers.isSchema(subschema)) throw new SchemaError('Expected "propertyNames" to be a schema (object or boolean)');

	  for (var property in instance) {
	    if(getEnumerableProperty(instance, property) !== undefined){
	      var res = this.validateSchema(property, subschema, options, ctx.makeChild(subschema));
	      result.importErrors(res);
	    }
	  }

	  return result;
	};

	/**
	 * Validates properties
	 * @param instance
	 * @param schema
	 * @param options
	 * @param ctx
	 * @return {String|null|ValidatorResult}
	 */
	validators.properties = function validateProperties (instance, schema, options, ctx) {
	  if(!this.types.object(instance)) return;
	  var result = new ValidatorResult(instance, schema, options, ctx);
	  var properties = schema.properties || {};
	  for (var property in properties) {
	    var subschema = properties[property];
	    if(subschema===undefined){
	      continue;
	    }else if(subschema===null){
	      throw new SchemaError('Unexpected null, expected schema in "properties"');
	    }
	    if (typeof options.preValidateProperty == 'function') {
	      options.preValidateProperty(instance, property, subschema, options, ctx);
	    }
	    var prop = getEnumerableProperty(instance, property);
	    var res = this.validateSchema(prop, subschema, options, ctx.makeChild(subschema, property));
	    if(res.instance !== result.instance[property]) result.instance[property] = res.instance;
	    result.importErrors(res);
	  }
	  return result;
	};

	/**
	 * Test a specific property within in instance against the additionalProperties schema attribute
	 * This ignores properties with definitions in the properties schema attribute, but no other attributes.
	 * If too many more types of property-existence tests pop up they may need their own class of tests (like `type` has)
	 * @private
	 * @return {boolean}
	 */
	function testAdditionalProperty (instance, schema, options, ctx, property, result) {
	  if(!this.types.object(instance)) return;
	  if (schema.properties && schema.properties[property] !== undefined) {
	    return;
	  }
	  if (schema.additionalProperties === false) {
	    result.addError({
	      name: 'additionalProperties',
	      argument: property,
	      message: "is not allowed to have the additional property " + JSON.stringify(property),
	    });
	  } else {
	    var additionalProperties = schema.additionalProperties || {};

	    if (typeof options.preValidateProperty == 'function') {
	      options.preValidateProperty(instance, property, additionalProperties, options, ctx);
	    }

	    var res = this.validateSchema(instance[property], additionalProperties, options, ctx.makeChild(additionalProperties, property));
	    if(res.instance !== result.instance[property]) result.instance[property] = res.instance;
	    result.importErrors(res);
	  }
	}

	/**
	 * Validates patternProperties
	 * @param instance
	 * @param schema
	 * @param options
	 * @param ctx
	 * @return {String|null|ValidatorResult}
	 */
	validators.patternProperties = function validatePatternProperties (instance, schema, options, ctx) {
	  if(!this.types.object(instance)) return;
	  var result = new ValidatorResult(instance, schema, options, ctx);
	  var patternProperties = schema.patternProperties || {};

	  for (var property in instance) {
	    var test = true;
	    for (var pattern in patternProperties) {
	      var subschema = patternProperties[pattern];
	      if(subschema===undefined){
	        continue;
	      }else if(subschema===null){
	        throw new SchemaError('Unexpected null, expected schema in "patternProperties"');
	      }
	      try {
	        var regexp = new RegExp(pattern, 'u');
	      } catch(_e) {
	        // In the event the stricter handling causes an error, fall back on the forgiving handling
	        // DEPRECATED
	        regexp = new RegExp(pattern);
	      }
	      if (!regexp.test(property)) {
	        continue;
	      }
	      test = false;

	      if (typeof options.preValidateProperty == 'function') {
	        options.preValidateProperty(instance, property, subschema, options, ctx);
	      }

	      var res = this.validateSchema(instance[property], subschema, options, ctx.makeChild(subschema, property));
	      if(res.instance !== result.instance[property]) result.instance[property] = res.instance;
	      result.importErrors(res);
	    }
	    if (test) {
	      testAdditionalProperty.call(this, instance, schema, options, ctx, property, result);
	    }
	  }

	  return result;
	};

	/**
	 * Validates additionalProperties
	 * @param instance
	 * @param schema
	 * @param options
	 * @param ctx
	 * @return {String|null|ValidatorResult}
	 */
	validators.additionalProperties = function validateAdditionalProperties (instance, schema, options, ctx) {
	  if(!this.types.object(instance)) return;
	  // if patternProperties is defined then we'll test when that one is called instead
	  if (schema.patternProperties) {
	    return null;
	  }
	  var result = new ValidatorResult(instance, schema, options, ctx);
	  for (var property in instance) {
	    testAdditionalProperty.call(this, instance, schema, options, ctx, property, result);
	  }
	  return result;
	};

	/**
	 * Validates whether the instance value is at least of a certain length, when the instance value is a string.
	 * @param instance
	 * @param schema
	 * @return {String|null}
	 */
	validators.minProperties = function validateMinProperties (instance, schema, options, ctx) {
	  if (!this.types.object(instance)) return;
	  var result = new ValidatorResult(instance, schema, options, ctx);
	  var keys = Object.keys(instance);
	  if (!(keys.length >= schema.minProperties)) {
	    result.addError({
	      name: 'minProperties',
	      argument: schema.minProperties,
	      message: "does not meet minimum property length of " + schema.minProperties,
	    });
	  }
	  return result;
	};

	/**
	 * Validates whether the instance value is at most of a certain length, when the instance value is a string.
	 * @param instance
	 * @param schema
	 * @return {String|null}
	 */
	validators.maxProperties = function validateMaxProperties (instance, schema, options, ctx) {
	  if (!this.types.object(instance)) return;
	  var result = new ValidatorResult(instance, schema, options, ctx);
	  var keys = Object.keys(instance);
	  if (!(keys.length <= schema.maxProperties)) {
	    result.addError({
	      name: 'maxProperties',
	      argument: schema.maxProperties,
	      message: "does not meet maximum property length of " + schema.maxProperties,
	    });
	  }
	  return result;
	};

	/**
	 * Validates items when instance is an array
	 * @param instance
	 * @param schema
	 * @param options
	 * @param ctx
	 * @return {String|null|ValidatorResult}
	 */
	validators.items = function validateItems (instance, schema, options, ctx) {
	  var self = this;
	  if (!this.types.array(instance)) return;
	  if (schema.items===undefined) return;
	  var result = new ValidatorResult(instance, schema, options, ctx);
	  instance.every(function (value, i) {
	    if(Array.isArray(schema.items)){
	      var items =  schema.items[i]===undefined ? schema.additionalItems : schema.items[i];
	    }else {
	      var items = schema.items;
	    }
	    if (items === undefined) {
	      return true;
	    }
	    if (items === false) {
	      result.addError({
	        name: 'items',
	        message: "additionalItems not permitted",
	      });
	      return false;
	    }
	    var res = self.validateSchema(value, items, options, ctx.makeChild(items, i));
	    if(res.instance !== result.instance[i]) result.instance[i] = res.instance;
	    result.importErrors(res);
	    return true;
	  });
	  return result;
	};

	/**
	 * Validates the "contains" keyword
	 * @param instance
	 * @param schema
	 * @param options
	 * @param ctx
	 * @return {String|null|ValidatorResult}
	 */
	validators.contains = function validateContains (instance, schema, options, ctx) {
	  var self = this;
	  if (!this.types.array(instance)) return;
	  if (schema.contains===undefined) return;
	  if (!helpers.isSchema(schema.contains)) throw new Error('Expected "contains" keyword to be a schema');
	  var result = new ValidatorResult(instance, schema, options, ctx);
	  var count = instance.some(function (value, i) {
	    var res = self.validateSchema(value, schema.contains, options, ctx.makeChild(schema.contains, i));
	    return res.errors.length===0;
	  });
	  if(count===false){
	    result.addError({
	      name: 'contains',
	      argument: schema.contains,
	      message: "must contain an item matching given schema",
	    });
	  }
	  return result;
	};

	/**
	 * Validates minimum and exclusiveMinimum when the type of the instance value is a number.
	 * @param instance
	 * @param schema
	 * @return {String|null}
	 */
	validators.minimum = function validateMinimum (instance, schema, options, ctx) {
	  if (!this.types.number(instance)) return;
	  var result = new ValidatorResult(instance, schema, options, ctx);
	  if (schema.exclusiveMinimum && schema.exclusiveMinimum === true) {
	    if(!(instance > schema.minimum)){
	      result.addError({
	        name: 'minimum',
	        argument: schema.minimum,
	        message: "must be greater than " + schema.minimum,
	      });
	    }
	  } else {
	    if(!(instance >= schema.minimum)){
	      result.addError({
	        name: 'minimum',
	        argument: schema.minimum,
	        message: "must be greater than or equal to " + schema.minimum,
	      });
	    }
	  }
	  return result;
	};

	/**
	 * Validates maximum and exclusiveMaximum when the type of the instance value is a number.
	 * @param instance
	 * @param schema
	 * @return {String|null}
	 */
	validators.maximum = function validateMaximum (instance, schema, options, ctx) {
	  if (!this.types.number(instance)) return;
	  var result = new ValidatorResult(instance, schema, options, ctx);
	  if (schema.exclusiveMaximum && schema.exclusiveMaximum === true) {
	    if(!(instance < schema.maximum)){
	      result.addError({
	        name: 'maximum',
	        argument: schema.maximum,
	        message: "must be less than " + schema.maximum,
	      });
	    }
	  } else {
	    if(!(instance <= schema.maximum)){
	      result.addError({
	        name: 'maximum',
	        argument: schema.maximum,
	        message: "must be less than or equal to " + schema.maximum,
	      });
	    }
	  }
	  return result;
	};

	/**
	 * Validates the number form of exclusiveMinimum when the type of the instance value is a number.
	 * @param instance
	 * @param schema
	 * @return {String|null}
	 */
	validators.exclusiveMinimum = function validateExclusiveMinimum (instance, schema, options, ctx) {
	  // Support the boolean form of exclusiveMinimum, which is handled by the "minimum" keyword.
	  if(typeof schema.exclusiveMinimum === 'boolean') return;
	  if (!this.types.number(instance)) return;
	  var result = new ValidatorResult(instance, schema, options, ctx);
	  var valid = instance > schema.exclusiveMinimum;
	  if (!valid) {
	    result.addError({
	      name: 'exclusiveMinimum',
	      argument: schema.exclusiveMinimum,
	      message: "must be strictly greater than " + schema.exclusiveMinimum,
	    });
	  }
	  return result;
	};

	/**
	 * Validates the number form of exclusiveMaximum when the type of the instance value is a number.
	 * @param instance
	 * @param schema
	 * @return {String|null}
	 */
	validators.exclusiveMaximum = function validateExclusiveMaximum (instance, schema, options, ctx) {
	  // Support the boolean form of exclusiveMaximum, which is handled by the "maximum" keyword.
	  if(typeof schema.exclusiveMaximum === 'boolean') return;
	  if (!this.types.number(instance)) return;
	  var result = new ValidatorResult(instance, schema, options, ctx);
	  var valid = instance < schema.exclusiveMaximum;
	  if (!valid) {
	    result.addError({
	      name: 'exclusiveMaximum',
	      argument: schema.exclusiveMaximum,
	      message: "must be strictly less than " + schema.exclusiveMaximum,
	    });
	  }
	  return result;
	};

	/**
	 * Perform validation for multipleOf and divisibleBy, which are essentially the same.
	 * @param instance
	 * @param schema
	 * @param validationType
	 * @param errorMessage
	 * @returns {String|null}
	 */
	var validateMultipleOfOrDivisbleBy = function validateMultipleOfOrDivisbleBy (instance, schema, options, ctx, validationType, errorMessage) {
	  if (!this.types.number(instance)) return;

	  var validationArgument = schema[validationType];
	  if (validationArgument == 0) {
	    throw new SchemaError(validationType + " cannot be zero");
	  }

	  var result = new ValidatorResult(instance, schema, options, ctx);

	  var instanceDecimals = helpers.getDecimalPlaces(instance);
	  var divisorDecimals = helpers.getDecimalPlaces(validationArgument);

	  var maxDecimals = Math.max(instanceDecimals , divisorDecimals);
	  var multiplier = Math.pow(10, maxDecimals);

	  if (Math.round(instance * multiplier) % Math.round(validationArgument * multiplier) !== 0) {
	    result.addError({
	      name: validationType,
	      argument:  validationArgument,
	      message: errorMessage + JSON.stringify(validationArgument),
	    });
	  }

	  return result;
	};

	/**
	 * Validates divisibleBy when the type of the instance value is a number.
	 * @param instance
	 * @param schema
	 * @return {String|null}
	 */
	validators.multipleOf = function validateMultipleOf (instance, schema, options, ctx) {
	  return validateMultipleOfOrDivisbleBy.call(this, instance, schema, options, ctx, "multipleOf", "is not a multiple of (divisible by) ");
	};

	/**
	 * Validates multipleOf when the type of the instance value is a number.
	 * @param instance
	 * @param schema
	 * @return {String|null}
	 */
	validators.divisibleBy = function validateDivisibleBy (instance, schema, options, ctx) {
	  return validateMultipleOfOrDivisbleBy.call(this, instance, schema, options, ctx, "divisibleBy", "is not divisible by (multiple of) ");
	};

	/**
	 * Validates whether the instance value is present.
	 * @param instance
	 * @param schema
	 * @return {String|null}
	 */
	validators.required = function validateRequired (instance, schema, options, ctx) {
	  var result = new ValidatorResult(instance, schema, options, ctx);
	  if (instance === undefined && schema.required === true) {
	    // A boolean form is implemented for reverse-compatibility with schemas written against older drafts
	    result.addError({
	      name: 'required',
	      message: "is required",
	    });
	  } else if (this.types.object(instance) && Array.isArray(schema.required)) {
	    schema.required.forEach(function(n){
	      if(getEnumerableProperty(instance, n)===undefined){
	        result.addError({
	          name: 'required',
	          argument: n,
	          message: "requires property " + JSON.stringify(n),
	        });
	      }
	    });
	  }
	  return result;
	};

	/**
	 * Validates whether the instance value matches the regular expression, when the instance value is a string.
	 * @param instance
	 * @param schema
	 * @return {String|null}
	 */
	validators.pattern = function validatePattern (instance, schema, options, ctx) {
	  if (!this.types.string(instance)) return;
	  var result = new ValidatorResult(instance, schema, options, ctx);
	  var pattern = schema.pattern;
	  try {
	    var regexp = new RegExp(pattern, 'u');
	  } catch(_e) {
	    // In the event the stricter handling causes an error, fall back on the forgiving handling
	    // DEPRECATED
	    regexp = new RegExp(pattern);
	  }
	  if (!instance.match(regexp)) {
	    result.addError({
	      name: 'pattern',
	      argument: schema.pattern,
	      message: "does not match pattern " + JSON.stringify(schema.pattern.toString()),
	    });
	  }
	  return result;
	};

	/**
	 * Validates whether the instance value is of a certain defined format or a custom
	 * format.
	 * The following formats are supported for string types:
	 *   - date-time
	 *   - date
	 *   - time
	 *   - ip-address
	 *   - ipv6
	 *   - uri
	 *   - color
	 *   - host-name
	 *   - alpha
	 *   - alpha-numeric
	 *   - utc-millisec
	 * @param instance
	 * @param schema
	 * @param [options]
	 * @param [ctx]
	 * @return {String|null}
	 */
	validators.format = function validateFormat (instance, schema, options, ctx) {
	  if (instance===undefined) return;
	  var result = new ValidatorResult(instance, schema, options, ctx);
	  if (!result.disableFormat && !helpers.isFormat(instance, schema.format, this)) {
	    result.addError({
	      name: 'format',
	      argument: schema.format,
	      message: "does not conform to the " + JSON.stringify(schema.format) + " format",
	    });
	  }
	  return result;
	};

	/**
	 * Validates whether the instance value is at least of a certain length, when the instance value is a string.
	 * @param instance
	 * @param schema
	 * @return {String|null}
	 */
	validators.minLength = function validateMinLength (instance, schema, options, ctx) {
	  if (!this.types.string(instance)) return;
	  var result = new ValidatorResult(instance, schema, options, ctx);
	  var hsp = instance.match(/[\uDC00-\uDFFF]/g);
	  var length = instance.length - (hsp ? hsp.length : 0);
	  if (!(length >= schema.minLength)) {
	    result.addError({
	      name: 'minLength',
	      argument: schema.minLength,
	      message: "does not meet minimum length of " + schema.minLength,
	    });
	  }
	  return result;
	};

	/**
	 * Validates whether the instance value is at most of a certain length, when the instance value is a string.
	 * @param instance
	 * @param schema
	 * @return {String|null}
	 */
	validators.maxLength = function validateMaxLength (instance, schema, options, ctx) {
	  if (!this.types.string(instance)) return;
	  var result = new ValidatorResult(instance, schema, options, ctx);
	  // TODO if this was already computed in "minLength", use that value instead of re-computing
	  var hsp = instance.match(/[\uDC00-\uDFFF]/g);
	  var length = instance.length - (hsp ? hsp.length : 0);
	  if (!(length <= schema.maxLength)) {
	    result.addError({
	      name: 'maxLength',
	      argument: schema.maxLength,
	      message: "does not meet maximum length of " + schema.maxLength,
	    });
	  }
	  return result;
	};

	/**
	 * Validates whether instance contains at least a minimum number of items, when the instance is an Array.
	 * @param instance
	 * @param schema
	 * @return {String|null}
	 */
	validators.minItems = function validateMinItems (instance, schema, options, ctx) {
	  if (!this.types.array(instance)) return;
	  var result = new ValidatorResult(instance, schema, options, ctx);
	  if (!(instance.length >= schema.minItems)) {
	    result.addError({
	      name: 'minItems',
	      argument: schema.minItems,
	      message: "does not meet minimum length of " + schema.minItems,
	    });
	  }
	  return result;
	};

	/**
	 * Validates whether instance contains no more than a maximum number of items, when the instance is an Array.
	 * @param instance
	 * @param schema
	 * @return {String|null}
	 */
	validators.maxItems = function validateMaxItems (instance, schema, options, ctx) {
	  if (!this.types.array(instance)) return;
	  var result = new ValidatorResult(instance, schema, options, ctx);
	  if (!(instance.length <= schema.maxItems)) {
	    result.addError({
	      name: 'maxItems',
	      argument: schema.maxItems,
	      message: "does not meet maximum length of " + schema.maxItems,
	    });
	  }
	  return result;
	};

	/**
	 * Deep compares arrays for duplicates
	 * @param v
	 * @param i
	 * @param a
	 * @private
	 * @return {boolean}
	 */
	function testArrays (v, i, a) {
	  var j, len = a.length;
	  for (j = i + 1, len; j < len; j++) {
	    if (helpers.deepCompareStrict(v, a[j])) {
	      return false;
	    }
	  }
	  return true;
	}

	/**
	 * Validates whether there are no duplicates, when the instance is an Array.
	 * @param instance
	 * @return {String|null}
	 */
	validators.uniqueItems = function validateUniqueItems (instance, schema, options, ctx) {
	  if (schema.uniqueItems!==true) return;
	  if (!this.types.array(instance)) return;
	  var result = new ValidatorResult(instance, schema, options, ctx);
	  if (!instance.every(testArrays)) {
	    result.addError({
	      name: 'uniqueItems',
	      message: "contains duplicate item",
	    });
	  }
	  return result;
	};

	/**
	 * Validate for the presence of dependency properties, if the instance is an object.
	 * @param instance
	 * @param schema
	 * @param options
	 * @param ctx
	 * @return {null|ValidatorResult}
	 */
	validators.dependencies = function validateDependencies (instance, schema, options, ctx) {
	  if (!this.types.object(instance)) return;
	  var result = new ValidatorResult(instance, schema, options, ctx);
	  for (var property in schema.dependencies) {
	    if (instance[property] === undefined) {
	      continue;
	    }
	    var dep = schema.dependencies[property];
	    var childContext = ctx.makeChild(dep, property);
	    if (typeof dep == 'string') {
	      dep = [dep];
	    }
	    if (Array.isArray(dep)) {
	      dep.forEach(function (prop) {
	        if (instance[prop] === undefined) {
	          result.addError({
	            // FIXME there's two different "dependencies" errors here with slightly different outputs
	            // Can we make these the same? Or should we create different error types?
	            name: 'dependencies',
	            argument: childContext.propertyPath,
	            message: "property " + prop + " not found, required by " + childContext.propertyPath,
	          });
	        }
	      });
	    } else {
	      var res = this.validateSchema(instance, dep, options, childContext);
	      if(result.instance !== res.instance) result.instance = res.instance;
	      if (res && res.errors.length) {
	        result.addError({
	          name: 'dependencies',
	          argument: childContext.propertyPath,
	          message: "does not meet dependency required by " + childContext.propertyPath,
	        });
	        result.importErrors(res);
	      }
	    }
	  }
	  return result;
	};

	/**
	 * Validates whether the instance value is one of the enumerated values.
	 *
	 * @param instance
	 * @param schema
	 * @return {ValidatorResult|null}
	 */
	validators['enum'] = function validateEnum (instance, schema, options, ctx) {
	  if (instance === undefined) {
	    return null;
	  }
	  if (!Array.isArray(schema['enum'])) {
	    throw new SchemaError("enum expects an array", schema);
	  }
	  var result = new ValidatorResult(instance, schema, options, ctx);
	  if (!schema['enum'].some(helpers.deepCompareStrict.bind(null, instance))) {
	    result.addError({
	      name: 'enum',
	      argument: schema['enum'],
	      message: "is not one of enum values: " + schema['enum'].map(String).join(','),
	    });
	  }
	  return result;
	};

	/**
	 * Validates whether the instance exactly matches a given value
	 *
	 * @param instance
	 * @param schema
	 * @return {ValidatorResult|null}
	 */
	validators['const'] = function validateEnum (instance, schema, options, ctx) {
	  if (instance === undefined) {
	    return null;
	  }
	  var result = new ValidatorResult(instance, schema, options, ctx);
	  if (!helpers.deepCompareStrict(schema['const'], instance)) {
	    result.addError({
	      name: 'const',
	      argument: schema['const'],
	      message: "does not exactly match expected constant: " + schema['const'],
	    });
	  }
	  return result;
	};

	/**
	 * Validates whether the instance if of a prohibited type.
	 * @param instance
	 * @param schema
	 * @param options
	 * @param ctx
	 * @return {null|ValidatorResult}
	 */
	validators.not = validators.disallow = function validateNot (instance, schema, options, ctx) {
	  var self = this;
	  if(instance===undefined) return null;
	  var result = new ValidatorResult(instance, schema, options, ctx);
	  var notTypes = schema.not || schema.disallow;
	  if(!notTypes) return null;
	  if(!Array.isArray(notTypes)) notTypes=[notTypes];
	  notTypes.forEach(function (type) {
	    if (self.testType(instance, schema, options, ctx, type)) {
	      var id = type && (type.$id || type.id);
	      var schemaId = id || type;
	      result.addError({
	        name: 'not',
	        argument: schemaId,
	        message: "is of prohibited type " + schemaId,
	      });
	    }
	  });
	  return result;
	};

	attribute_1 = attribute;
	return attribute_1;
}

var scan = {};

var hasRequiredScan;

function requireScan () {
	if (hasRequiredScan) return scan;
	hasRequiredScan = 1;

	var helpers = requireHelpers();

	scan.SchemaScanResult = SchemaScanResult;
	function SchemaScanResult(found, ref){
	  this.id = found;
	  this.ref = ref;
	}

	/**
	 * Adds a schema with a certain urn to the Validator instance.
	 * @param string uri
	 * @param object schema
	 * @return {Object}
	 */
	scan.scan = function scan(base, schema){
	  function scanSchema(baseuri, schema){
	    if(!schema || typeof schema!='object') return;
	    // Mark all referenced schemas so we can tell later which schemas are referred to, but never defined
	    if(schema.$ref){
	      let resolvedUri = helpers.resolveUrl(baseuri,schema.$ref);
	      ref[resolvedUri] = ref[resolvedUri] ? ref[resolvedUri]+1 : 0;
	      return;
	    }
	    var id = schema.$id || schema.id;
	    let resolvedBase = helpers.resolveUrl(baseuri,id);
	    var ourBase = id ? resolvedBase : baseuri;
	    if (ourBase) {
	      // If there's no fragment, append an empty one
	      if(ourBase.indexOf('#')<0) ourBase += '#';
	      if(found[ourBase]){
	        if(!helpers.deepCompareStrict(found[ourBase], schema)){
	          throw new Error('Schema <'+ourBase+'> already exists with different definition');
	        }
	        return found[ourBase];
	      }
	      found[ourBase] = schema;
	      // strip trailing fragment
	      if(ourBase[ourBase.length-1]=='#'){
	        found[ourBase.substring(0, ourBase.length-1)] = schema;
	      }
	    }
	    scanArray(ourBase+'/items', (Array.isArray(schema.items)?schema.items:[schema.items]));
	    scanArray(ourBase+'/extends', (Array.isArray(schema.extends)?schema.extends:[schema.extends]));
	    scanSchema(ourBase+'/additionalItems', schema.additionalItems);
	    scanObject(ourBase+'/properties', schema.properties);
	    scanSchema(ourBase+'/additionalProperties', schema.additionalProperties);
	    scanObject(ourBase+'/definitions', schema.definitions);
	    scanObject(ourBase+'/patternProperties', schema.patternProperties);
	    scanObject(ourBase+'/dependencies', schema.dependencies);
	    scanArray(ourBase+'/disallow', schema.disallow);
	    scanArray(ourBase+'/allOf', schema.allOf);
	    scanArray(ourBase+'/anyOf', schema.anyOf);
	    scanArray(ourBase+'/oneOf', schema.oneOf);
	    scanSchema(ourBase+'/not', schema.not);
	  }
	  function scanArray(baseuri, schemas){
	    if(!Array.isArray(schemas)) return;
	    for(var i=0; i<schemas.length; i++){
	      scanSchema(baseuri+'/'+i, schemas[i]);
	    }
	  }
	  function scanObject(baseuri, schemas){
	    if(!schemas || typeof schemas!='object') return;
	    for(var p in schemas){
	      scanSchema(baseuri+'/'+p, schemas[p]);
	    }
	  }

	  var found = {};
	  var ref = {};
	  scanSchema(base, schema);
	  return new SchemaScanResult(found, ref);
	};
	return scan;
}

var validator;
var hasRequiredValidator;

function requireValidator () {
	if (hasRequiredValidator) return validator;
	hasRequiredValidator = 1;

	var attribute = requireAttribute();
	var helpers = requireHelpers();
	var scanSchema = requireScan().scan;
	var ValidatorResult = helpers.ValidatorResult;
	var ValidatorResultError = helpers.ValidatorResultError;
	var SchemaError = helpers.SchemaError;
	var SchemaContext = helpers.SchemaContext;
	//var anonymousBase = 'vnd.jsonschema:///';
	var anonymousBase = '/';

	/**
	 * Creates a new Validator object
	 * @name Validator
	 * @constructor
	 */
	var Validator = function Validator () {
	  // Allow a validator instance to override global custom formats or to have their
	  // own custom formats.
	  this.customFormats = Object.create(Validator.prototype.customFormats);
	  this.schemas = {};
	  this.unresolvedRefs = [];

	  // Use Object.create to make this extensible without Validator instances stepping on each other's toes.
	  this.types = Object.create(types);
	  this.attributes = Object.create(attribute.validators);
	};

	// Allow formats to be registered globally.
	Validator.prototype.customFormats = {};

	// Hint at the presence of a property
	Validator.prototype.schemas = null;
	Validator.prototype.types = null;
	Validator.prototype.attributes = null;
	Validator.prototype.unresolvedRefs = null;

	/**
	 * Adds a schema with a certain urn to the Validator instance.
	 * @param schema
	 * @param urn
	 * @return {Object}
	 */
	Validator.prototype.addSchema = function addSchema (schema, base) {
	  var self = this;
	  if (!schema) {
	    return null;
	  }
	  var scan = scanSchema(base||anonymousBase, schema);
	  var ourUri = base || schema.$id || schema.id;
	  for(var uri in scan.id){
	    this.schemas[uri] = scan.id[uri];
	  }
	  for(var uri in scan.ref){
	    // If this schema is already defined, it will be filtered out by the next step
	    this.unresolvedRefs.push(uri);
	  }
	  // Remove newly defined schemas from unresolvedRefs
	  this.unresolvedRefs = this.unresolvedRefs.filter(function(uri){
	    return typeof self.schemas[uri]==='undefined';
	  });
	  return this.schemas[ourUri];
	};

	Validator.prototype.addSubSchemaArray = function addSubSchemaArray(baseuri, schemas) {
	  if(!Array.isArray(schemas)) return;
	  for(var i=0; i<schemas.length; i++){
	    this.addSubSchema(baseuri, schemas[i]);
	  }
	};

	Validator.prototype.addSubSchemaObject = function addSubSchemaArray(baseuri, schemas) {
	  if(!schemas || typeof schemas!='object') return;
	  for(var p in schemas){
	    this.addSubSchema(baseuri, schemas[p]);
	  }
	};



	/**
	 * Sets all the schemas of the Validator instance.
	 * @param schemas
	 */
	Validator.prototype.setSchemas = function setSchemas (schemas) {
	  this.schemas = schemas;
	};

	/**
	 * Returns the schema of a certain urn
	 * @param urn
	 */
	Validator.prototype.getSchema = function getSchema (urn) {
	  return this.schemas[urn];
	};

	/**
	 * Validates instance against the provided schema
	 * @param instance
	 * @param schema
	 * @param [options]
	 * @param [ctx]
	 * @return {Array}
	 */
	Validator.prototype.validate = function validate (instance, schema, options, ctx) {
	  if((typeof schema !== 'boolean' && typeof schema !== 'object') || schema === null){
	    throw new SchemaError('Expected `schema` to be an object or boolean');
	  }
	  if (!options) {
	    options = {};
	  }
	  // This section indexes subschemas in the provided schema, so they don't need to be added with Validator#addSchema
	  // This will work so long as the function at uri.resolve() will resolve a relative URI to a relative URI
	  var id = schema.$id || schema.id;
	  let base = helpers.resolveUrl(options.base,id||'');
	  if(!ctx){
	    ctx = new SchemaContext(schema, options, [], base, Object.create(this.schemas));
	    if (!ctx.schemas[base]) {
	      ctx.schemas[base] = schema;
	    }
	    var found = scanSchema(base, schema);
	    for(var n in found.id){
	      var sch = found.id[n];
	      ctx.schemas[n] = sch;
	    }
	  }
	  if(options.required && instance===undefined){
	    var result = new ValidatorResult(instance, schema, options, ctx);
	    result.addError('is required, but is undefined');
	    return result;
	  }
	  var result = this.validateSchema(instance, schema, options, ctx);
	  if (!result) {
	    throw new Error('Result undefined');
	  }else if(options.throwAll && result.errors.length){
	    throw new ValidatorResultError(result);
	  }
	  return result;
	};

	/**
	* @param Object schema
	* @return mixed schema uri or false
	*/
	function shouldResolve(schema) {
	  var ref = (typeof schema === 'string') ? schema : schema.$ref;
	  if (typeof ref=='string') return ref;
	  return false;
	}

	/**
	 * Validates an instance against the schema (the actual work horse)
	 * @param instance
	 * @param schema
	 * @param options
	 * @param ctx
	 * @private
	 * @return {ValidatorResult}
	 */
	Validator.prototype.validateSchema = function validateSchema (instance, schema, options, ctx) {
	  var result = new ValidatorResult(instance, schema, options, ctx);

	  // Support for the true/false schemas
	  if(typeof schema==='boolean') {
	    if(schema===true){
	      // `true` is always valid
	      schema = {};
	    }else if(schema===false){
	      // `false` is always invalid
	      schema = {type: []};
	    }
	  }else if(!schema){
	    // This might be a string
	    throw new Error("schema is undefined");
	  }

	  if (schema['extends']) {
	    if (Array.isArray(schema['extends'])) {
	      var schemaobj = {schema: schema, ctx: ctx};
	      schema['extends'].forEach(this.schemaTraverser.bind(this, schemaobj));
	      schema = schemaobj.schema;
	      schemaobj.schema = null;
	      schemaobj.ctx = null;
	      schemaobj = null;
	    } else {
	      schema = helpers.deepMerge(schema, this.superResolve(schema['extends'], ctx));
	    }
	  }

	  // If passed a string argument, load that schema URI
	  var switchSchema = shouldResolve(schema);
	  if (switchSchema) {
	    var resolved = this.resolve(schema, switchSchema, ctx);
	    var subctx = new SchemaContext(resolved.subschema, options, ctx.path, resolved.switchSchema, ctx.schemas);
	    return this.validateSchema(instance, resolved.subschema, options, subctx);
	  }

	  var skipAttributes = options && options.skipAttributes || [];
	  // Validate each schema attribute against the instance
	  for (var key in schema) {
	    if (!attribute.ignoreProperties[key] && skipAttributes.indexOf(key) < 0) {
	      var validatorErr = null;
	      var validator = this.attributes[key];
	      if (validator) {
	        validatorErr = validator.call(this, instance, schema, options, ctx);
	      } else if (options.allowUnknownAttributes === false) {
	        // This represents an error with the schema itself, not an invalid instance
	        throw new SchemaError("Unsupported attribute: " + key, schema);
	      }
	      if (validatorErr) {
	        result.importErrors(validatorErr);
	      }
	    }
	  }

	  if (typeof options.rewrite == 'function') {
	    var value = options.rewrite.call(this, instance, schema, options, ctx);
	    result.instance = value;
	  }
	  return result;
	};

	/**
	* @private
	* @param Object schema
	* @param SchemaContext ctx
	* @returns Object schema or resolved schema
	*/
	Validator.prototype.schemaTraverser = function schemaTraverser (schemaobj, s) {
	  schemaobj.schema = helpers.deepMerge(schemaobj.schema, this.superResolve(s, schemaobj.ctx));
	};

	/**
	* @private
	* @param Object schema
	* @param SchemaContext ctx
	* @returns Object schema or resolved schema
	*/
	Validator.prototype.superResolve = function superResolve (schema, ctx) {
	  var ref = shouldResolve(schema);
	  if(ref) {
	    return this.resolve(schema, ref, ctx).subschema;
	  }
	  return schema;
	};

	/**
	* @private
	* @param Object schema
	* @param Object switchSchema
	* @param SchemaContext ctx
	* @return Object resolved schemas {subschema:String, switchSchema: String}
	* @throws SchemaError
	*/
	Validator.prototype.resolve = function resolve (schema, switchSchema, ctx) {
	  switchSchema = ctx.resolve(switchSchema);
	  // First see if the schema exists under the provided URI
	  if (ctx.schemas[switchSchema]) {
	    return {subschema: ctx.schemas[switchSchema], switchSchema: switchSchema};
	  }
	  // Else try walking the property pointer
	  let parsed = new URL(switchSchema,'thismessage::/');
	  let fragment = parsed.hash;
	  var document = fragment && fragment.length && switchSchema.substr(0, switchSchema.length - fragment.length);
	  if (!document || !ctx.schemas[document]) {
	    throw new SchemaError("no such schema <" + switchSchema + ">", schema);
	  }
	  var subschema = helpers.objectGetPath(ctx.schemas[document], fragment.substr(1));
	  if(subschema===undefined){
	    throw new SchemaError("no such schema " + fragment + " located in <" + document + ">", schema);
	  }
	  return {subschema: subschema, switchSchema: switchSchema};
	};

	/**
	 * Tests whether the instance if of a certain type.
	 * @private
	 * @param instance
	 * @param schema
	 * @param options
	 * @param ctx
	 * @param type
	 * @return {boolean}
	 */
	Validator.prototype.testType = function validateType (instance, schema, options, ctx, type) {
	  if(type===undefined){
	    return;
	  }else if(type===null){
	    throw new SchemaError('Unexpected null in "type" keyword');
	  }
	  if (typeof this.types[type] == 'function') {
	    return this.types[type].call(this, instance);
	  }
	  if (type && typeof type == 'object') {
	    var res = this.validateSchema(instance, type, options, ctx);
	    return res === undefined || !(res && res.errors.length);
	  }
	  // Undefined or properties not on the list are acceptable, same as not being defined
	  return true;
	};

	var types = Validator.prototype.types = {};
	types.string = function testString (instance) {
	  return typeof instance == 'string';
	};
	types.number = function testNumber (instance) {
	  // isFinite returns false for NaN, Infinity, and -Infinity
	  return typeof instance == 'number' && isFinite(instance);
	};
	types.integer = function testInteger (instance) {
	  return (typeof instance == 'number') && instance % 1 === 0;
	};
	types.boolean = function testBoolean (instance) {
	  return typeof instance == 'boolean';
	};
	types.array = function testArray (instance) {
	  return Array.isArray(instance);
	};
	types['null'] = function testNull (instance) {
	  return instance === null;
	};
	types.date = function testDate (instance) {
	  return instance instanceof Date;
	};
	types.any = function testAny (instance) {
	  return true;
	};
	types.object = function testObject (instance) {
	  // TODO: fix this - see #15
	  return instance && (typeof instance === 'object') && !(Array.isArray(instance)) && !(instance instanceof Date);
	};

	validator = Validator;
	return validator;
}

var hasRequiredLib;

function requireLib () {
	if (hasRequiredLib) return lib;
	hasRequiredLib = 1;

	var Validator = lib.Validator = requireValidator();

	lib.ValidatorResult = requireHelpers().ValidatorResult;
	lib.ValidatorResultError = requireHelpers().ValidatorResultError;
	lib.ValidationError = requireHelpers().ValidationError;
	lib.SchemaError = requireHelpers().SchemaError;
	lib.SchemaScanResult = requireScan().SchemaScanResult;
	lib.scan = requireScan().scan;

	lib.validate = function (instance, schema, options) {
	  var v = new Validator();
	  return v.validate(instance, schema, options);
	};
	return lib;
}

var libExports = requireLib();

const toolBaseSchema = zod.z.object({
    name: zod.z.string(),
    description: zod.z.string(),
});
class SimpleToolCallContext {
    constructor(logger, signal, callId) {
        this.logger = logger;
        this.signal = signal;
        this.callId = callId;
    }
    status(text) {
        this.logger.info(text);
    }
    warn(text) {
        this.logger.warn(text);
    }
}
const functionToolSchema = toolBaseSchema.extend({
    type: zod.z.literal("function"),
    parametersSchema: zodSchemaSchema,
    checkParameters: zod.z.function(),
    implementation: zod.z.function(),
});
const rawFunctionToolSchema = toolBaseSchema.extend({
    type: zod.z.literal("rawFunction"),
    parametersSchema: zodSchemaSchema,
    checkParameters: zod.z.function(),
    implementation: zod.z.function(),
});
const unimplementedRawFunctionToolSchema = toolBaseSchema.extend({
    type: zod.z.literal("unimplementedRawFunction"),
    parametersJsonSchema: zodSchemaSchema,
    checkParameters: zod.z.function(),
    implementation: zod.z.function(),
});
const remoteToolSchema = toolBaseSchema.extend({
    type: zod.z.literal("remoteTool"),
    pluginIdentifier: zod.z.string(),
    parametersJsonSchema: zodSchemaSchema,
    checkParameters: zod.z.function(),
    implementation: zod.z.function(),
});
zod.z.discriminatedUnion("type", [
    functionToolSchema,
    rawFunctionToolSchema,
    unimplementedRawFunctionToolSchema,
    remoteToolSchema,
]);
/**
 * A function that can be used to create a function `Tool` given a function definition and its
 * implementation.
 *
 * @public
 */
function tool({ name, description, parameters, implementation, }) {
    const parametersSchema = zod.z.object(parameters);
    return {
        name,
        description,
        type: "function",
        parametersSchema,
        checkParameters(params) {
            const parametersParseResult = parametersSchema.safeParse(params);
            if (!parametersParseResult.success) {
                throw new Error(text `
          Failed to parse arguments for tool "${name}":
          ${parametersParseResult.error.message}
        `);
            }
        },
        implementation: (params, ctx) => {
            const parametersParseResult = parametersSchema.safeParse(params);
            if (!parametersParseResult.success) {
                throw new Error(text `
          Failed to parse arguments for tool "${name}":
          ${parametersParseResult.error.message}
        `);
            }
            return implementation(parametersParseResult.data, ctx); // Erase the types
        },
    };
}
function jsonSchemaValidationErrorToAIReadableText(root, validationErrors) {
    return validationErrors
        .map(validatioNError => {
        const fullPath = [root, ...validatioNError.path].join(".");
        return `${fullPath} ${validatioNError.message}`;
    })
        .join("\n");
}
/**
 * A function that can be used to create a raw function `Tool` given a function definition and its
 * implementation.
 *
 * @public
 * @experimental Not stable, will likely change in the future.
 */
function rawFunctionTool({ name, description, parametersJsonSchema, implementation, }) {
    const jsonSchemaValidator = new libExports.Validator();
    return {
        name,
        description,
        type: "rawFunction",
        parametersJsonSchema,
        checkParameters(params) {
            const validationResult = jsonSchemaValidator.validate(params, parametersJsonSchema);
            if (validationResult.errors.length > 0) {
                throw new Error(text `
          Failed to parse arguments for tool "${name}":
          ${jsonSchemaValidationErrorToAIReadableText("params", validationResult.errors)}
        `);
            }
        },
        implementation,
    };
}
class UnimplementedToolError extends Error {
    constructor(toolName) {
        super(`Tool "${toolName}" is not implemented.`);
    }
}
/**
 * A function that can be used to create a raw function `Tool` that is not implemented yet. When
 * using `.act`, upon encountering an unimplemented tool, the `.act` will stop gracefully.
 *
 * @public
 * @experimental Not stable, will likely change in the future.
 */
function unimplementedRawFunctionTool({ name, description, parametersJsonSchema, }) {
    const jsonSchemaValidator = new libExports.Validator();
    return {
        name,
        description,
        type: "unimplementedRawFunction",
        parametersJsonSchema,
        checkParameters(params) {
            const validationResult = jsonSchemaValidator.validate(params, parametersJsonSchema);
            if (validationResult.errors.length > 0) {
                throw new Error(text `
          Failed to parse arguments for tool "${name}":
          ${jsonSchemaValidationErrorToAIReadableText("params", validationResult.errors)}
        `);
            }
        },
        implementation: () => {
            throw new UnimplementedToolError(name);
        },
    };
}
/**
 * Creates a tool that represents a remote tool exposed by an LMStudio plugin. This function is not
 * exposed and is used internally by the plugins namespace.
 */
function internalCreateRemoteTool({ name, description, pluginIdentifier, parametersJsonSchema, implementation, }) {
    return {
        name,
        description,
        type: "remoteTool",
        pluginIdentifier,
        parametersJsonSchema,
        checkParameters: params => {
            const jsonSchemaValidator = new libExports.Validator();
            const validationResult = jsonSchemaValidator.validate(params, parametersJsonSchema);
            if (validationResult.errors.length > 0) {
                throw new Error(text `
          Failed to parse arguments for tool "${name}":
          ${jsonSchemaValidationErrorToAIReadableText("params", validationResult.errors)}
        `);
            }
        },
        implementation,
    };
}
function functionToolToLLMTool(tool) {
    return {
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: zodToJsonSchema.zodToJsonSchema(tool.parametersSchema),
        },
    };
}
function rawFunctionToolToLLMTool(tool) {
    return {
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parametersJsonSchema,
        },
    };
}
function remoteToolToLLMTool(tool) {
    return {
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parametersJsonSchema,
        },
    };
}
/**
 * Convert a `Tool` to a internal `LLMTool`.
 */
function toolToLLMTool(tool) {
    const type = tool.type;
    switch (type) {
        case "function":
            return functionToolToLLMTool(tool);
        case "rawFunction":
        case "unimplementedRawFunction":
            return rawFunctionToolToLLMTool(tool);
        case "remoteTool":
            return remoteToolToLLMTool(tool);
        default: {
            const exhaustiveCheck = type;
            throw new Error(`Unhandled type: ${exhaustiveCheck}`);
        }
    }
}

/**
 * Represents an error that is caused by invalid tool call request.
 *
 * @public
 * @experimental [EXP-GRANULAR-ACT] More granular .act status reporting is experimental and may
 * change in the future
 */
class ToolCallRequestError extends Error {
    constructor(message, 
    /**
     * The raw output that was generated by the model before the tool call. The exact nature of this
     * fields depends on the error. It sometimes include the entire tool calls section, or sometimes
     * just the single tool call that failed.
     *
     * This field is not always available, and may be `undefined`.
     *
     * @experimental [EXP-GRANULAR-ACT] More granular .act status reporting is experimental and may
     * change in the future
     * @experimental [EXP-NON-ACT-TOOL-CALLBACKS] Tool call callbacks in .respond/.complete is in an
     * experimental feature. This may change in the future without warning.
     */
    rawContent) {
        super(message);
        this.rawContent = rawContent;
    }
}

class BackendInterface {
    constructor() {
        this.unhandledEndpoints = new Set();
        this.existingEndpointNames = new Set();
        this.rpcEndpoints = new Map();
        this.channelEndpoints = new Map();
        this.signalEndpoints = new Map();
        this.writableSignalEndpoints = new Map();
    }
    withContextType() {
        return this;
    }
    assertEndpointNameNotExists(endpointName) {
        if (this.existingEndpointNames.has(endpointName)) {
            throw new Error(`Endpoint with name ${endpointName} already exists`);
        }
    }
    /**
     * Register an Rpc endpoint.
     */
    addRpcEndpoint(endpointName, { parameter, returns, serialization = "raw", }) {
        this.assertEndpointNameNotExists(endpointName);
        this.existingEndpointNames.add(endpointName);
        this.rpcEndpoints.set(endpointName, {
            name: endpointName,
            parameter,
            returns,
            serialization,
            handler: null,
        });
        return this;
    }
    addChannelEndpoint(endpointName, { creationParameter, toServerPacket, toClientPacket, serialization = "raw", }) {
        this.assertEndpointNameNotExists(endpointName);
        this.existingEndpointNames.add(endpointName);
        this.channelEndpoints.set(endpointName, {
            name: endpointName,
            creationParameter,
            toServerPacket,
            toClientPacket,
            serialization,
            handler: null,
        });
        return this;
    }
    addSignalEndpoint(endpointName, { creationParameter, signalData, serialization = "raw", }) {
        this.assertEndpointNameNotExists(endpointName);
        this.existingEndpointNames.add(endpointName);
        this.signalEndpoints.set(endpointName, {
            name: endpointName,
            creationParameter,
            signalData,
            serialization,
            handler: null,
        });
        return this;
    }
    addWritableSignalEndpoint(endpointName, { creationParameter, signalData, serialization = "raw", }) {
        this.assertEndpointNameNotExists(endpointName);
        this.existingEndpointNames.add(endpointName);
        this.writableSignalEndpoints.set(endpointName, {
            name: endpointName,
            creationParameter,
            signalData,
            serialization,
            handler: null,
        });
        return this;
    }
    /**
     * Adds a handler for an Rpc endpoint.
     *
     * @param endpointName - The name of the endpoint.
     * @param handler - The handler function. Will be called when the endpoint is invoked. When
     * called, the first parameter is the context, and the second parameter is the "parameter" for the
     * RPC call. Can return a value or a promise that resolves to the result.
     */
    handleRpcEndpoint(endpointName, handler) {
        const endpoint = this.rpcEndpoints.get(endpointName);
        if (endpoint === undefined) {
            throw new Error(`No Rpc endpoint with name ${endpointName}`);
        }
        if (endpoint.handler !== null) {
            throw new Error(`Rpc endpoint with name ${endpointName} already has a handler`);
        }
        endpoint.handler = handler;
        this.unhandledEndpoints.delete(endpointName);
    }
    /**
     * Adds a handler for a channel endpoint.
     *
     * @param endpointName - The name of the endpoint.
     * @param handler - The handler function. Will be called when the client creates a channel for
     * this endpoint. When called, the first parameter is the context, the second parameter is the
     * "creationParameter" for the channel, and the third parameter is a channel object that can be
     * used to send and receive messages from the client.
     *
     * Must return a promise. Once that promise is settled, the channel will be closed.
     */
    handleChannelEndpoint(endpointName, handler) {
        const endpoint = this.channelEndpoints.get(endpointName);
        if (endpoint === undefined) {
            throw new Error(`No channel endpoint with name ${endpointName}`);
        }
        if (endpoint.handler !== null) {
            throw new Error(`Channel endpoint with name ${endpointName} already has a handler`);
        }
        endpoint.handler = handler;
        this.unhandledEndpoints.delete(endpointName);
    }
    /**
     * Adds a handler for a signal endpoint.
     *
     * @param endpointName - The name of the endpoint.
     * @param handler - The handler function. Will be called when the client creates a signal, and at
     * least one subscriber is attached to that signal. When called, the first parameter is the
     * context, and the second parameter is the "creationParameter" for the signal. This method should
     * return a SignalLike, or a promise that resolves to a SignalLike.
     *
     * Note: There is no 1-to-1 correlation between the signal on the client side and the number of
     * times this handler is called. Every time the number of client subscribers changes from 0 to 1,
     * this handler will be called. Every time the number of client subscribers changes from 1 to 0,
     * the signal returned from this handler will be unsubscribed.
     *
     * Caution: Do NOT create new subscriptions that don't self-terminate in this handler, as it will
     * cause memory leaks. That is, either:
     *
     * - Return a signal that already exists
     * - Create and return a LazySignal
     */
    handleSignalEndpoint(endpointName, handler) {
        const endpoint = this.signalEndpoints.get(endpointName);
        if (endpoint === undefined) {
            throw new Error(`No signal endpoint with name ${endpointName}`);
        }
        if (endpoint.handler !== null) {
            throw new Error(`Signal endpoint with name ${endpointName} already has a handler`);
        }
        endpoint.handler = handler;
        this.unhandledEndpoints.delete(endpointName);
    }
    /**
     * Adds a handler for a writable signal endpoint.
     *
     * @param endpointName - The name of the endpoint.
     * @param handler - The handler function. Will be called when the client creates a writable
     * signal, and at least one subscriber is attached to that signal. When called, the first
     * parameter is the context, and the second parameter is the "creationParameter" for the signal.
     * This method should return a tuple of the signal and an update function. The update function
     * should be called with the new data, patches, and tags to update the signal.
     *
     * Note: There is no 1-to-1 correlation between the signal on the client side and the number of
     * times this handler is called. Every time the number of client subscribers changes from 0 to 1,
     * this handler will be called. Every time the number of client subscribers changes from 1 to 0
     * the signal returned from this handler will be unsubscribed.
     *
     * Caution: Do NOT create new subscriptions that don't self-terminate in this handler, as it will
     * cause memory leaks. That is, either:
     *
     * - Return a signal that already exists
     * - Create and return a LazySignal
     */
    handleWritableSignalEndpoint(endpointName, handler) {
        const endpoint = this.writableSignalEndpoints.get(endpointName);
        if (endpoint === undefined) {
            throw new Error(`No writable signal endpoint with name ${endpointName}`);
        }
        if (endpoint.handler !== null) {
            throw new Error(`Writable signal endpoint with name ${endpointName} already has a handler`);
        }
        endpoint.handler = handler;
        this.unhandledEndpoints.delete(endpointName);
    }
    assertAllEndpointsHandled() {
        if (this.unhandledEndpoints.size > 0) {
            throw new Error(`The following endpoints were not handled: ${Array.from(this.unhandledEndpoints).join(", ")}`);
        }
    }
    getRpcEndpoint(endpointName) {
        return this.rpcEndpoints.get(endpointName);
    }
    getAllRpcEndpoints() {
        return [...this.rpcEndpoints.values()];
    }
    getChannelEndpoint(endpointName) {
        return this.channelEndpoints.get(endpointName);
    }
    getAllChannelEndpoints() {
        return [...this.channelEndpoints.values()];
    }
    getSignalEndpoint(endpointName) {
        return this.signalEndpoints.get(endpointName);
    }
    getAllSignalEndpoints() {
        return [...this.signalEndpoints.values()];
    }
    getWritableSignalEndpoint(endpointName) {
        return this.writableSignalEndpoints.get(endpointName);
    }
    getAllWritableSignalEndpoints() {
        return [...this.writableSignalEndpoints.values()];
    }
}

var ConnectionStatus;
(function (ConnectionStatus) {
    /**
     * The underlying transport is connected and is communicating properly.
     */
    ConnectionStatus["Connected"] = "CONNECTED";
    /**
     * The underlying transport has errored out.
     */
    ConnectionStatus["Errored"] = "ERRORED";
    /**
     * The channel has been properly closed and no more messages will be sent or received.
     */
    ConnectionStatus["Closed"] = "CLOSED";
})(ConnectionStatus || (ConnectionStatus = {}));
const logger = new SimpleLogger("Channel");
class Channel {
    constructor(innerSend) {
        this.innerSend = innerSend;
        this.nextAckId = 0;
        /**
         * A map for messages that are waiting for an ACK. The values are the functions to resolve or
         * reject the corresponding promise.
         */
        this.waitingForAck = new Map();
        /**
         * Returned as a part of create. It should be called by the controlling port.
         */
        this.receivedACK = (ackId) => {
            if (this.connectionStatus.get() !== ConnectionStatus.Connected) {
                logger.warn("Received ACK while in status", this.connectionStatus.get());
                return;
            }
            const waiting = this.waitingForAck.get(ackId);
            if (waiting === undefined) {
                logger.warn("Received ACK for a message that is no longer waiting for ACK, ackId =", ackId);
                return;
            }
            waiting.resolve();
            this.waitingForAck.delete(ackId);
        };
        /**
         * Returned as a part of create. It should be called by the controlling port.
         */
        this.receivedMessage = (packet) => {
            if (this.connectionStatus.get() !== ConnectionStatus.Connected) {
                logger.warn("Received message while in status", this.connectionStatus.get());
                return;
            }
            this.emitOnMessage(packet);
        };
        /**
         * Returned as a part of create. It should be called by the controlling port.
         */
        this.errored = (error) => {
            if (this.connectionStatus.get() !== ConnectionStatus.Connected) {
                logger.warn("Received error while in status", this.connectionStatus.get());
                return;
            }
            this.rejectAllWaitingForAck(error);
            this.setConnectionStatus(ConnectionStatus.Errored);
            this.emitOnError(error);
        };
        /**
         * Returned as a part of create. It should be called by the controlling port.
         */
        this.closed = () => {
            this.rejectAllWaitingForAck(new Error("Channel closed"));
            this.setConnectionStatus(ConnectionStatus.Closed);
            this.emitOnClose();
        };
        [this.onMessage, this.emitOnMessage] = BufferedEvent.create();
        [this.onError, this.emitOnError] = BufferedEvent.create();
        [this.onClose, this.emitOnClose] = BufferedEvent.create();
        [this.connectionStatus, this.setConnectionStatus] = Signal.create(ConnectionStatus.Connected);
    }
    rejectAllWaitingForAck(error) {
        const rejects = Array.from(this.waitingForAck.values()).map(({ reject }) => reject);
        this.waitingForAck.clear();
        for (const reject of rejects) {
            reject(error);
        }
    }
    static create(innerSend) {
        const channel = new Channel(innerSend);
        return {
            channel,
            receivedAck: channel.receivedACK,
            receivedMessage: channel.receivedMessage,
            errored: channel.errored,
            closed: channel.closed,
        };
    }
    send(packet) {
        this.innerSend(packet);
    }
    sendAndWaitForACK(packet) {
        const { promise, resolve, reject } = makePromise();
        const ackId = this.nextAckId;
        this.nextAckId++;
        this.waitingForAck.set(ackId, { resolve, reject });
        this.innerSend(packet, ackId);
        return promise;
    }
}

var DoubleIndexedKV = /** @class */ (function () {
    function DoubleIndexedKV() {
        this.keyToValue = new Map();
        this.valueToKey = new Map();
    }
    DoubleIndexedKV.prototype.set = function (key, value) {
        this.keyToValue.set(key, value);
        this.valueToKey.set(value, key);
    };
    DoubleIndexedKV.prototype.getByKey = function (key) {
        return this.keyToValue.get(key);
    };
    DoubleIndexedKV.prototype.getByValue = function (value) {
        return this.valueToKey.get(value);
    };
    DoubleIndexedKV.prototype.clear = function () {
        this.keyToValue.clear();
        this.valueToKey.clear();
    };
    return DoubleIndexedKV;
}());

var Registry = /** @class */ (function () {
    function Registry(generateIdentifier) {
        this.generateIdentifier = generateIdentifier;
        this.kv = new DoubleIndexedKV();
    }
    Registry.prototype.register = function (value, identifier) {
        if (this.kv.getByValue(value)) {
            return;
        }
        if (!identifier) {
            identifier = this.generateIdentifier(value);
        }
        this.kv.set(identifier, value);
    };
    Registry.prototype.clear = function () {
        this.kv.clear();
    };
    Registry.prototype.getIdentifier = function (value) {
        return this.kv.getByValue(value);
    };
    Registry.prototype.getValue = function (identifier) {
        return this.kv.getByKey(identifier);
    };
    return Registry;
}());

var __extends = (globalThis && globalThis.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        if (typeof b !== "function" && b !== null)
            throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
var ClassRegistry = /** @class */ (function (_super) {
    __extends(ClassRegistry, _super);
    function ClassRegistry() {
        var _this = _super.call(this, function (c) { return c.name; }) || this;
        _this.classToAllowedProps = new Map();
        return _this;
    }
    ClassRegistry.prototype.register = function (value, options) {
        if (typeof options === 'object') {
            if (options.allowProps) {
                this.classToAllowedProps.set(value, options.allowProps);
            }
            _super.prototype.register.call(this, value, options.identifier);
        }
        else {
            _super.prototype.register.call(this, value, options);
        }
    };
    ClassRegistry.prototype.getAllowedProps = function (value) {
        return this.classToAllowedProps.get(value);
    };
    return ClassRegistry;
}(Registry));

var __read$3 = (globalThis && globalThis.__read) || function (o, n) {
    var m = typeof Symbol === "function" && o[Symbol.iterator];
    if (!m) return o;
    var i = m.call(o), r, ar = [], e;
    try {
        while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
    }
    catch (error) { e = { error: error }; }
    finally {
        try {
            if (r && !r.done && (m = i["return"])) m.call(i);
        }
        finally { if (e) throw e.error; }
    }
    return ar;
};
function valuesOfObj(record) {
    if ('values' in Object) {
        // eslint-disable-next-line es5/no-es6-methods
        return Object.values(record);
    }
    var values = [];
    // eslint-disable-next-line no-restricted-syntax
    for (var key in record) {
        if (record.hasOwnProperty(key)) {
            values.push(record[key]);
        }
    }
    return values;
}
function find(record, predicate) {
    var values = valuesOfObj(record);
    if ('find' in values) {
        // eslint-disable-next-line es5/no-es6-methods
        return values.find(predicate);
    }
    var valuesNotNever = values;
    for (var i = 0; i < valuesNotNever.length; i++) {
        var value = valuesNotNever[i];
        if (predicate(value)) {
            return value;
        }
    }
    return undefined;
}
function forEach(record, run) {
    Object.entries(record).forEach(function (_a) {
        var _b = __read$3(_a, 2), key = _b[0], value = _b[1];
        return run(value, key);
    });
}
function includes(arr, value) {
    return arr.indexOf(value) !== -1;
}
function findArr(record, predicate) {
    for (var i = 0; i < record.length; i++) {
        var value = record[i];
        if (predicate(value)) {
            return value;
        }
    }
    return undefined;
}

var CustomTransformerRegistry = /** @class */ (function () {
    function CustomTransformerRegistry() {
        this.transfomers = {};
    }
    CustomTransformerRegistry.prototype.register = function (transformer) {
        this.transfomers[transformer.name] = transformer;
    };
    CustomTransformerRegistry.prototype.findApplicable = function (v) {
        return find(this.transfomers, function (transformer) {
            return transformer.isApplicable(v);
        });
    };
    CustomTransformerRegistry.prototype.findByName = function (name) {
        return this.transfomers[name];
    };
    return CustomTransformerRegistry;
}());

var getType$1 = function (payload) {
    return Object.prototype.toString.call(payload).slice(8, -1);
};
var isUndefined = function (payload) {
    return typeof payload === 'undefined';
};
var isNull = function (payload) { return payload === null; };
var isPlainObject$1 = function (payload) {
    if (typeof payload !== 'object' || payload === null)
        return false;
    if (payload === Object.prototype)
        return false;
    if (Object.getPrototypeOf(payload) === null)
        return true;
    return Object.getPrototypeOf(payload) === Object.prototype;
};
var isEmptyObject = function (payload) {
    return isPlainObject$1(payload) && Object.keys(payload).length === 0;
};
var isArray$1 = function (payload) {
    return Array.isArray(payload);
};
var isString = function (payload) {
    return typeof payload === 'string';
};
var isNumber = function (payload) {
    return typeof payload === 'number' && !isNaN(payload);
};
var isBoolean = function (payload) {
    return typeof payload === 'boolean';
};
var isRegExp = function (payload) {
    return payload instanceof RegExp;
};
var isMap = function (payload) {
    return payload instanceof Map;
};
var isSet = function (payload) {
    return payload instanceof Set;
};
var isSymbol = function (payload) {
    return getType$1(payload) === 'Symbol';
};
var isDate = function (payload) {
    return payload instanceof Date && !isNaN(payload.valueOf());
};
var isError = function (payload) {
    return payload instanceof Error;
};
var isNaNValue = function (payload) {
    return typeof payload === 'number' && isNaN(payload);
};
var isPrimitive = function (payload) {
    return isBoolean(payload) ||
        isNull(payload) ||
        isUndefined(payload) ||
        isNumber(payload) ||
        isString(payload) ||
        isSymbol(payload);
};
var isBigint = function (payload) {
    return typeof payload === 'bigint';
};
var isInfinite = function (payload) {
    return payload === Infinity || payload === -Infinity;
};
var isTypedArray = function (payload) {
    return ArrayBuffer.isView(payload) && !(payload instanceof DataView);
};
var isURL = function (payload) { return payload instanceof URL; };

var escapeKey = function (key) { return key.replace(/\./g, '\\.'); };
var stringifyPath = function (path) {
    return path
        .map(String)
        .map(escapeKey)
        .join('.');
};
var parsePath = function (string) {
    var result = [];
    var segment = '';
    for (var i = 0; i < string.length; i++) {
        var char = string.charAt(i);
        var isEscapedDot = char === '\\' && string.charAt(i + 1) === '.';
        if (isEscapedDot) {
            segment += '.';
            i++;
            continue;
        }
        var isEndOfSegment = char === '.';
        if (isEndOfSegment) {
            result.push(segment);
            segment = '';
            continue;
        }
        segment += char;
    }
    var lastSegment = segment;
    result.push(lastSegment);
    return result;
};

var __assign$1 = (globalThis && globalThis.__assign) || function () {
    __assign$1 = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign$1.apply(this, arguments);
};
var __read$2 = (globalThis && globalThis.__read) || function (o, n) {
    var m = typeof Symbol === "function" && o[Symbol.iterator];
    if (!m) return o;
    var i = m.call(o), r, ar = [], e;
    try {
        while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
    }
    catch (error) { e = { error: error }; }
    finally {
        try {
            if (r && !r.done && (m = i["return"])) m.call(i);
        }
        finally { if (e) throw e.error; }
    }
    return ar;
};
var __spreadArray$2 = (globalThis && globalThis.__spreadArray) || function (to, from) {
    for (var i = 0, il = from.length, j = to.length; i < il; i++, j++)
        to[j] = from[i];
    return to;
};
function simpleTransformation(isApplicable, annotation, transform, untransform) {
    return {
        isApplicable: isApplicable,
        annotation: annotation,
        transform: transform,
        untransform: untransform
    };
}
var simpleRules = [
    simpleTransformation(isUndefined, 'undefined', function () { return null; }, function () { return undefined; }),
    simpleTransformation(isBigint, 'bigint', function (v) { return v.toString(); }, function (v) {
        if (typeof BigInt !== 'undefined') {
            return BigInt(v);
        }
        console.error('Please add a BigInt polyfill.');
        return v;
    }),
    simpleTransformation(isDate, 'Date', function (v) { return v.toISOString(); }, function (v) { return new Date(v); }),
    simpleTransformation(isError, 'Error', function (v, superJson) {
        var baseError = {
            name: v.name,
            message: v.message
        };
        superJson.allowedErrorProps.forEach(function (prop) {
            baseError[prop] = v[prop];
        });
        return baseError;
    }, function (v, superJson) {
        var e = new Error(v.message);
        e.name = v.name;
        e.stack = v.stack;
        superJson.allowedErrorProps.forEach(function (prop) {
            e[prop] = v[prop];
        });
        return e;
    }),
    simpleTransformation(isRegExp, 'regexp', function (v) { return '' + v; }, function (regex) {
        var body = regex.slice(1, regex.lastIndexOf('/'));
        var flags = regex.slice(regex.lastIndexOf('/') + 1);
        return new RegExp(body, flags);
    }),
    simpleTransformation(isSet, 'set', 
    // (sets only exist in es6+)
    // eslint-disable-next-line es5/no-es6-methods
    function (v) { return __spreadArray$2([], __read$2(v.values())); }, function (v) { return new Set(v); }),
    simpleTransformation(isMap, 'map', function (v) { return __spreadArray$2([], __read$2(v.entries())); }, function (v) { return new Map(v); }),
    simpleTransformation(function (v) { return isNaNValue(v) || isInfinite(v); }, 'number', function (v) {
        if (isNaNValue(v)) {
            return 'NaN';
        }
        if (v > 0) {
            return 'Infinity';
        }
        else {
            return '-Infinity';
        }
    }, Number),
    simpleTransformation(function (v) { return v === 0 && 1 / v === -Infinity; }, 'number', function () {
        return '-0';
    }, Number),
    simpleTransformation(isURL, 'URL', function (v) { return v.toString(); }, function (v) { return new URL(v); }),
];
function compositeTransformation(isApplicable, annotation, transform, untransform) {
    return {
        isApplicable: isApplicable,
        annotation: annotation,
        transform: transform,
        untransform: untransform
    };
}
var symbolRule = compositeTransformation(function (s, superJson) {
    if (isSymbol(s)) {
        var isRegistered = !!superJson.symbolRegistry.getIdentifier(s);
        return isRegistered;
    }
    return false;
}, function (s, superJson) {
    var identifier = superJson.symbolRegistry.getIdentifier(s);
    return ['symbol', identifier];
}, function (v) { return v.description; }, function (_, a, superJson) {
    var value = superJson.symbolRegistry.getValue(a[1]);
    if (!value) {
        throw new Error('Trying to deserialize unknown symbol');
    }
    return value;
});
var constructorToName = [
    Int8Array,
    Uint8Array,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    Uint8ClampedArray,
].reduce(function (obj, ctor) {
    obj[ctor.name] = ctor;
    return obj;
}, {});
var typedArrayRule = compositeTransformation(isTypedArray, function (v) { return ['typed-array', v.constructor.name]; }, function (v) { return __spreadArray$2([], __read$2(v)); }, function (v, a) {
    var ctor = constructorToName[a[1]];
    if (!ctor) {
        throw new Error('Trying to deserialize unknown typed array');
    }
    return new ctor(v);
});
function isInstanceOfRegisteredClass(potentialClass, superJson) {
    if (potentialClass === null || potentialClass === void 0 ? void 0 : potentialClass.constructor) {
        var isRegistered = !!superJson.classRegistry.getIdentifier(potentialClass.constructor);
        return isRegistered;
    }
    return false;
}
var classRule = compositeTransformation(isInstanceOfRegisteredClass, function (clazz, superJson) {
    var identifier = superJson.classRegistry.getIdentifier(clazz.constructor);
    return ['class', identifier];
}, function (clazz, superJson) {
    var allowedProps = superJson.classRegistry.getAllowedProps(clazz.constructor);
    if (!allowedProps) {
        return __assign$1({}, clazz);
    }
    var result = {};
    allowedProps.forEach(function (prop) {
        result[prop] = clazz[prop];
    });
    return result;
}, function (v, a, superJson) {
    var clazz = superJson.classRegistry.getValue(a[1]);
    if (!clazz) {
        throw new Error('Trying to deserialize unknown class - check https://github.com/blitz-js/superjson/issues/116#issuecomment-773996564');
    }
    return Object.assign(Object.create(clazz.prototype), v);
});
var customRule = compositeTransformation(function (value, superJson) {
    return !!superJson.customTransformerRegistry.findApplicable(value);
}, function (value, superJson) {
    var transformer = superJson.customTransformerRegistry.findApplicable(value);
    return ['custom', transformer.name];
}, function (value, superJson) {
    var transformer = superJson.customTransformerRegistry.findApplicable(value);
    return transformer.serialize(value);
}, function (v, a, superJson) {
    var transformer = superJson.customTransformerRegistry.findByName(a[1]);
    if (!transformer) {
        throw new Error('Trying to deserialize unknown custom value');
    }
    return transformer.deserialize(v);
});
var compositeRules = [classRule, symbolRule, customRule, typedArrayRule];
var transformValue = function (value, superJson) {
    var applicableCompositeRule = findArr(compositeRules, function (rule) {
        return rule.isApplicable(value, superJson);
    });
    if (applicableCompositeRule) {
        return {
            value: applicableCompositeRule.transform(value, superJson),
            type: applicableCompositeRule.annotation(value, superJson)
        };
    }
    var applicableSimpleRule = findArr(simpleRules, function (rule) {
        return rule.isApplicable(value, superJson);
    });
    if (applicableSimpleRule) {
        return {
            value: applicableSimpleRule.transform(value, superJson),
            type: applicableSimpleRule.annotation
        };
    }
    return undefined;
};
var simpleRulesByAnnotation = {};
simpleRules.forEach(function (rule) {
    simpleRulesByAnnotation[rule.annotation] = rule;
});
var untransformValue = function (json, type, superJson) {
    if (isArray$1(type)) {
        switch (type[0]) {
            case 'symbol':
                return symbolRule.untransform(json, type, superJson);
            case 'class':
                return classRule.untransform(json, type, superJson);
            case 'custom':
                return customRule.untransform(json, type, superJson);
            case 'typed-array':
                return typedArrayRule.untransform(json, type, superJson);
            default:
                throw new Error('Unknown transformation: ' + type);
        }
    }
    else {
        var transformation = simpleRulesByAnnotation[type];
        if (!transformation) {
            throw new Error('Unknown transformation: ' + type);
        }
        return transformation.untransform(json, superJson);
    }
};

var getNthKey = function (value, n) {
    var keys = value.keys();
    while (n > 0) {
        keys.next();
        n--;
    }
    return keys.next().value;
};
function validatePath(path) {
    if (includes(path, '__proto__')) {
        throw new Error('__proto__ is not allowed as a property');
    }
    if (includes(path, 'prototype')) {
        throw new Error('prototype is not allowed as a property');
    }
    if (includes(path, 'constructor')) {
        throw new Error('constructor is not allowed as a property');
    }
}
var getDeep = function (object, path) {
    validatePath(path);
    for (var i = 0; i < path.length; i++) {
        var key = path[i];
        if (isSet(object)) {
            object = getNthKey(object, +key);
        }
        else if (isMap(object)) {
            var row = +key;
            var type = +path[++i] === 0 ? 'key' : 'value';
            var keyOfRow = getNthKey(object, row);
            switch (type) {
                case 'key':
                    object = keyOfRow;
                    break;
                case 'value':
                    object = object.get(keyOfRow);
                    break;
            }
        }
        else {
            object = object[key];
        }
    }
    return object;
};
var setDeep = function (object, path, mapper) {
    validatePath(path);
    if (path.length === 0) {
        return mapper(object);
    }
    var parent = object;
    for (var i = 0; i < path.length - 1; i++) {
        var key = path[i];
        if (isArray$1(parent)) {
            var index = +key;
            parent = parent[index];
        }
        else if (isPlainObject$1(parent)) {
            parent = parent[key];
        }
        else if (isSet(parent)) {
            var row = +key;
            parent = getNthKey(parent, row);
        }
        else if (isMap(parent)) {
            var isEnd = i === path.length - 2;
            if (isEnd) {
                break;
            }
            var row = +key;
            var type = +path[++i] === 0 ? 'key' : 'value';
            var keyOfRow = getNthKey(parent, row);
            switch (type) {
                case 'key':
                    parent = keyOfRow;
                    break;
                case 'value':
                    parent = parent.get(keyOfRow);
                    break;
            }
        }
    }
    var lastKey = path[path.length - 1];
    if (isArray$1(parent)) {
        parent[+lastKey] = mapper(parent[+lastKey]);
    }
    else if (isPlainObject$1(parent)) {
        parent[lastKey] = mapper(parent[lastKey]);
    }
    if (isSet(parent)) {
        var oldValue = getNthKey(parent, +lastKey);
        var newValue = mapper(oldValue);
        if (oldValue !== newValue) {
            parent["delete"](oldValue);
            parent.add(newValue);
        }
    }
    if (isMap(parent)) {
        var row = +path[path.length - 2];
        var keyToRow = getNthKey(parent, row);
        var type = +lastKey === 0 ? 'key' : 'value';
        switch (type) {
            case 'key': {
                var newKey = mapper(keyToRow);
                parent.set(newKey, parent.get(keyToRow));
                if (newKey !== keyToRow) {
                    parent["delete"](keyToRow);
                }
                break;
            }
            case 'value': {
                parent.set(keyToRow, mapper(parent.get(keyToRow)));
                break;
            }
        }
    }
    return object;
};

var __read$1 = (globalThis && globalThis.__read) || function (o, n) {
    var m = typeof Symbol === "function" && o[Symbol.iterator];
    if (!m) return o;
    var i = m.call(o), r, ar = [], e;
    try {
        while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
    }
    catch (error) { e = { error: error }; }
    finally {
        try {
            if (r && !r.done && (m = i["return"])) m.call(i);
        }
        finally { if (e) throw e.error; }
    }
    return ar;
};
var __spreadArray$1 = (globalThis && globalThis.__spreadArray) || function (to, from) {
    for (var i = 0, il = from.length, j = to.length; i < il; i++, j++)
        to[j] = from[i];
    return to;
};
function traverse(tree, walker, origin) {
    if (origin === void 0) { origin = []; }
    if (!tree) {
        return;
    }
    if (!isArray$1(tree)) {
        forEach(tree, function (subtree, key) {
            return traverse(subtree, walker, __spreadArray$1(__spreadArray$1([], __read$1(origin)), __read$1(parsePath(key))));
        });
        return;
    }
    var _a = __read$1(tree, 2), nodeValue = _a[0], children = _a[1];
    if (children) {
        forEach(children, function (child, key) {
            traverse(child, walker, __spreadArray$1(__spreadArray$1([], __read$1(origin)), __read$1(parsePath(key))));
        });
    }
    walker(nodeValue, origin);
}
function applyValueAnnotations(plain, annotations, superJson) {
    traverse(annotations, function (type, path) {
        plain = setDeep(plain, path, function (v) { return untransformValue(v, type, superJson); });
    });
    return plain;
}
function applyReferentialEqualityAnnotations(plain, annotations) {
    function apply(identicalPaths, path) {
        var object = getDeep(plain, parsePath(path));
        identicalPaths.map(parsePath).forEach(function (identicalObjectPath) {
            plain = setDeep(plain, identicalObjectPath, function () { return object; });
        });
    }
    if (isArray$1(annotations)) {
        var _a = __read$1(annotations, 2), root = _a[0], other = _a[1];
        root.forEach(function (identicalPath) {
            plain = setDeep(plain, parsePath(identicalPath), function () { return plain; });
        });
        if (other) {
            forEach(other, apply);
        }
    }
    else {
        forEach(annotations, apply);
    }
    return plain;
}
var isDeep = function (object, superJson) {
    return isPlainObject$1(object) ||
        isArray$1(object) ||
        isMap(object) ||
        isSet(object) ||
        isInstanceOfRegisteredClass(object, superJson);
};
function addIdentity(object, path, identities) {
    var existingSet = identities.get(object);
    if (existingSet) {
        existingSet.push(path);
    }
    else {
        identities.set(object, [path]);
    }
}
function generateReferentialEqualityAnnotations(identitites, dedupe) {
    var result = {};
    var rootEqualityPaths = undefined;
    identitites.forEach(function (paths) {
        if (paths.length <= 1) {
            return;
        }
        // if we're not deduping, all of these objects continue existing.
        // putting the shortest path first makes it easier to parse for humans
        // if we're deduping though, only the first entry will still exist, so we can't do this optimisation.
        if (!dedupe) {
            paths = paths
                .map(function (path) { return path.map(String); })
                .sort(function (a, b) { return a.length - b.length; });
        }
        var _a = __read$1(paths), representativePath = _a[0], identicalPaths = _a.slice(1);
        if (representativePath.length === 0) {
            rootEqualityPaths = identicalPaths.map(stringifyPath);
        }
        else {
            result[stringifyPath(representativePath)] = identicalPaths.map(stringifyPath);
        }
    });
    if (rootEqualityPaths) {
        if (isEmptyObject(result)) {
            return [rootEqualityPaths];
        }
        else {
            return [rootEqualityPaths, result];
        }
    }
    else {
        return isEmptyObject(result) ? undefined : result;
    }
}
var walker = function (object, identities, superJson, dedupe, path, objectsInThisPath, seenObjects) {
    var _a;
    if (path === void 0) { path = []; }
    if (objectsInThisPath === void 0) { objectsInThisPath = []; }
    if (seenObjects === void 0) { seenObjects = new Map(); }
    var primitive = isPrimitive(object);
    if (!primitive) {
        addIdentity(object, path, identities);
        var seen = seenObjects.get(object);
        if (seen) {
            // short-circuit result if we've seen this object before
            return dedupe
                ? {
                    transformedValue: null
                }
                : seen;
        }
    }
    if (!isDeep(object, superJson)) {
        var transformed_1 = transformValue(object, superJson);
        var result_1 = transformed_1
            ? {
                transformedValue: transformed_1.value,
                annotations: [transformed_1.type]
            }
            : {
                transformedValue: object
            };
        if (!primitive) {
            seenObjects.set(object, result_1);
        }
        return result_1;
    }
    if (includes(objectsInThisPath, object)) {
        // prevent circular references
        return {
            transformedValue: null
        };
    }
    var transformationResult = transformValue(object, superJson);
    var transformed = (_a = transformationResult === null || transformationResult === void 0 ? void 0 : transformationResult.value) !== null && _a !== void 0 ? _a : object;
    var transformedValue = isArray$1(transformed) ? [] : {};
    var innerAnnotations = {};
    forEach(transformed, function (value, index) {
        var recursiveResult = walker(value, identities, superJson, dedupe, __spreadArray$1(__spreadArray$1([], __read$1(path)), [index]), __spreadArray$1(__spreadArray$1([], __read$1(objectsInThisPath)), [object]), seenObjects);
        transformedValue[index] = recursiveResult.transformedValue;
        if (isArray$1(recursiveResult.annotations)) {
            innerAnnotations[index] = recursiveResult.annotations;
        }
        else if (isPlainObject$1(recursiveResult.annotations)) {
            forEach(recursiveResult.annotations, function (tree, key) {
                innerAnnotations[escapeKey(index) + '.' + key] = tree;
            });
        }
    });
    var result = isEmptyObject(innerAnnotations)
        ? {
            transformedValue: transformedValue,
            annotations: !!transformationResult
                ? [transformationResult.type]
                : undefined
        }
        : {
            transformedValue: transformedValue,
            annotations: !!transformationResult
                ? [transformationResult.type, innerAnnotations]
                : innerAnnotations
        };
    if (!primitive) {
        seenObjects.set(object, result);
    }
    return result;
};

function getType(payload) {
  return Object.prototype.toString.call(payload).slice(8, -1);
}

function isArray(payload) {
  return getType(payload) === "Array";
}

function isPlainObject(payload) {
  if (getType(payload) !== "Object")
    return false;
  const prototype = Object.getPrototypeOf(payload);
  return !!prototype && prototype.constructor === Object && prototype === Object.prototype;
}

function assignProp(carry, key, newVal, originalObject, includeNonenumerable) {
  const propType = {}.propertyIsEnumerable.call(originalObject, key) ? "enumerable" : "nonenumerable";
  if (propType === "enumerable")
    carry[key] = newVal;
  if (includeNonenumerable && propType === "nonenumerable") {
    Object.defineProperty(carry, key, {
      value: newVal,
      enumerable: false,
      writable: true,
      configurable: true
    });
  }
}
function copy(target, options = {}) {
  if (isArray(target)) {
    return target.map((item) => copy(item, options));
  }
  if (!isPlainObject(target)) {
    return target;
  }
  const props = Object.getOwnPropertyNames(target);
  const symbols = Object.getOwnPropertySymbols(target);
  return [...props, ...symbols].reduce((carry, key) => {
    if (isArray(options.props) && !options.props.includes(key)) {
      return carry;
    }
    const val = target[key];
    const newVal = copy(val, options);
    assignProp(carry, key, newVal, target, options.nonenumerable);
    return carry;
  }, {});
}

var __assign = (globalThis && globalThis.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __read = (globalThis && globalThis.__read) || function (o, n) {
    var m = typeof Symbol === "function" && o[Symbol.iterator];
    if (!m) return o;
    var i = m.call(o), r, ar = [], e;
    try {
        while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
    }
    catch (error) { e = { error: error }; }
    finally {
        try {
            if (r && !r.done && (m = i["return"])) m.call(i);
        }
        finally { if (e) throw e.error; }
    }
    return ar;
};
var __spreadArray = (globalThis && globalThis.__spreadArray) || function (to, from) {
    for (var i = 0, il = from.length, j = to.length; i < il; i++, j++)
        to[j] = from[i];
    return to;
};
var SuperJSON = /** @class */ (function () {
    /**
     * @param dedupeReferentialEqualities  If true, SuperJSON will make sure only one instance of referentially equal objects are serialized and the rest are replaced with `null`.
     */
    function SuperJSON(_a) {
        var _b = _a === void 0 ? {} : _a, _c = _b.dedupe, dedupe = _c === void 0 ? false : _c;
        this.classRegistry = new ClassRegistry();
        this.symbolRegistry = new Registry(function (s) { var _a; return (_a = s.description) !== null && _a !== void 0 ? _a : ''; });
        this.customTransformerRegistry = new CustomTransformerRegistry();
        this.allowedErrorProps = [];
        this.dedupe = dedupe;
    }
    SuperJSON.prototype.serialize = function (object) {
        var identities = new Map();
        var output = walker(object, identities, this, this.dedupe);
        var res = {
            json: output.transformedValue
        };
        if (output.annotations) {
            res.meta = __assign(__assign({}, res.meta), { values: output.annotations });
        }
        var equalityAnnotations = generateReferentialEqualityAnnotations(identities, this.dedupe);
        if (equalityAnnotations) {
            res.meta = __assign(__assign({}, res.meta), { referentialEqualities: equalityAnnotations });
        }
        return res;
    };
    SuperJSON.prototype.deserialize = function (payload) {
        var json = payload.json, meta = payload.meta;
        var result = copy(json);
        if (meta === null || meta === void 0 ? void 0 : meta.values) {
            result = applyValueAnnotations(result, meta.values, this);
        }
        if (meta === null || meta === void 0 ? void 0 : meta.referentialEqualities) {
            result = applyReferentialEqualityAnnotations(result, meta.referentialEqualities);
        }
        return result;
    };
    SuperJSON.prototype.stringify = function (object) {
        return JSON.stringify(this.serialize(object));
    };
    SuperJSON.prototype.parse = function (string) {
        return this.deserialize(JSON.parse(string));
    };
    SuperJSON.prototype.registerClass = function (v, options) {
        this.classRegistry.register(v, options);
    };
    SuperJSON.prototype.registerSymbol = function (v, identifier) {
        this.symbolRegistry.register(v, identifier);
    };
    SuperJSON.prototype.registerCustom = function (transformer, name) {
        this.customTransformerRegistry.register(__assign({ name: name }, transformer));
    };
    SuperJSON.prototype.allowErrorProps = function () {
        var _a;
        var props = [];
        for (var _i = 0; _i < arguments.length; _i++) {
            props[_i] = arguments[_i];
        }
        (_a = this.allowedErrorProps).push.apply(_a, __spreadArray([], __read(props)));
    };
    SuperJSON.defaultInstance = new SuperJSON();
    SuperJSON.serialize = SuperJSON.defaultInstance.serialize.bind(SuperJSON.defaultInstance);
    SuperJSON.deserialize = SuperJSON.defaultInstance.deserialize.bind(SuperJSON.defaultInstance);
    SuperJSON.stringify = SuperJSON.defaultInstance.stringify.bind(SuperJSON.defaultInstance);
    SuperJSON.parse = SuperJSON.defaultInstance.parse.bind(SuperJSON.defaultInstance);
    SuperJSON.registerClass = SuperJSON.defaultInstance.registerClass.bind(SuperJSON.defaultInstance);
    SuperJSON.registerSymbol = SuperJSON.defaultInstance.registerSymbol.bind(SuperJSON.defaultInstance);
    SuperJSON.registerCustom = SuperJSON.defaultInstance.registerCustom.bind(SuperJSON.defaultInstance);
    SuperJSON.allowErrorProps = SuperJSON.defaultInstance.allowErrorProps.bind(SuperJSON.defaultInstance);
    return SuperJSON;
}());
var serialize$1 = SuperJSON.serialize;
var deserialize$1 = SuperJSON.deserialize;

/**
 * Serialize a value to another value using the specified serialization type.
 */
function serialize(type, value) {
    switch (type) {
        case "raw":
            return value;
        case "superjson":
            return serialize$1(value);
    }
}
function deserialize(type, value) {
    switch (type) {
        case "raw":
            return value;
        case "superjson":
            return deserialize$1(value);
    }
}
const serializedOpaqueSchema = zod.z.any();

const clientToServerMessageSchema = zod.z.discriminatedUnion("type", [
    // Communication
    zod.z.object({
        type: zod.z.literal("communicationWarning"),
        warning: zod.z.string(),
    }),
    zod.z.object({
        type: zod.z.literal("keepAlive"),
    }),
    // Channel
    zod.z.object({
        type: zod.z.literal("channelCreate"),
        endpoint: zod.z.string(),
        channelId: zod.z.number().int(),
        creationParameter: serializedOpaqueSchema,
    }),
    zod.z.object({
        type: zod.z.literal("channelSend"),
        channelId: zod.z.number().int(),
        message: serializedOpaqueSchema,
        ackId: zod.z.number().int().optional(),
    }),
    zod.z.object({
        type: zod.z.literal("channelAck"),
        channelId: zod.z.number().int(),
        ackId: zod.z.number().int(),
    }),
    // RPC
    zod.z.object({
        type: zod.z.literal("rpcCall"),
        endpoint: zod.z.string(),
        callId: zod.z.number().int(),
        parameter: serializedOpaqueSchema,
    }),
    // Readonly signal
    zod.z.object({
        type: zod.z.literal("signalSubscribe"),
        creationParameter: serializedOpaqueSchema,
        endpoint: zod.z.string(),
        subscribeId: zod.z.number().int(),
    }),
    zod.z.object({
        type: zod.z.literal("signalUnsubscribe"),
        subscribeId: zod.z.number().int(),
    }),
    // Writable signal
    zod.z.object({
        type: zod.z.literal("writableSignalSubscribe"),
        creationParameter: serializedOpaqueSchema,
        endpoint: zod.z.string(),
        subscribeId: zod.z.number().int(),
    }),
    zod.z.object({
        type: zod.z.literal("writableSignalUnsubscribe"),
        subscribeId: zod.z.number().int(),
    }),
    zod.z.object({
        type: zod.z.literal("writableSignalUpdate"),
        subscribeId: zod.z.number().int(),
        patches: zod.z.array(serializedOpaqueSchema),
        tags: zod.z.array(zod.z.string()),
    }),
]);
const serverToClientMessageSchema = zod.z.discriminatedUnion("type", [
    // Communication
    zod.z.object({
        type: zod.z.literal("communicationWarning"),
        warning: zod.z.string(),
    }),
    zod.z.object({
        type: zod.z.literal("keepAliveAck"),
    }),
    // Channel
    zod.z.object({
        type: zod.z.literal("channelSend"),
        channelId: zod.z.number().int(),
        message: serializedOpaqueSchema,
        ackId: zod.z.number().int().optional(),
    }),
    zod.z.object({
        type: zod.z.literal("channelAck"),
        channelId: zod.z.number().int(),
        ackId: zod.z.number().int(),
    }),
    zod.z.object({
        type: zod.z.literal("channelClose"),
        channelId: zod.z.number().int(),
    }),
    zod.z.object({
        type: zod.z.literal("channelError"),
        channelId: zod.z.number().int(),
        error: serializedLMSExtendedErrorSchema,
    }),
    // RPC
    zod.z.object({
        type: zod.z.literal("rpcResult"),
        callId: zod.z.number().int(),
        result: serializedOpaqueSchema,
    }),
    zod.z.object({
        type: zod.z.literal("rpcError"),
        callId: zod.z.number().int(),
        error: serializedLMSExtendedErrorSchema,
    }),
    // Readonly signal
    zod.z.object({
        type: zod.z.literal("signalUpdate"),
        subscribeId: zod.z.number().int(),
        patches: zod.z.array(serializedOpaqueSchema),
        tags: zod.z.array(zod.z.string()),
    }),
    zod.z.object({
        type: zod.z.literal("signalError"),
        subscribeId: zod.z.number().int(),
        error: serializedLMSExtendedErrorSchema,
    }),
    // Writable signal
    zod.z.object({
        type: zod.z.literal("writableSignalUpdate"),
        subscribeId: zod.z.number().int(),
        patches: zod.z.array(serializedOpaqueSchema),
        tags: zod.z.array(zod.z.string()),
    }),
    zod.z.object({
        type: zod.z.literal("writableSignalError"),
        subscribeId: zod.z.number().int(),
        error: serializedLMSExtendedErrorSchema,
    }),
]);
class Transport {
    constructor() {
        /**
         * Whether this transport has been disposed.
         */
        this.disposed = false;
    }
    async [Symbol.asyncDispose]() {
        if (this.disposed) {
            throw new Error("Cannot dispose twice");
        }
        // Only sets disposed to true, transport implementations should override this method to
        // perform actual cleanup.
        this.disposed = true;
    }
}
class ClientTransport extends Transport {
    parseIncomingMessage(message) {
        return serverToClientMessageSchema.parse(message);
    }
    send(message) {
        const result = clientToServerMessageSchema.parse(message);
        this.sendViaTransport(result);
    }
    /**
     * Called by the client port when the number of open communications changes from 0 to 1. This
     * usually indicates the `socket.ref()` should be called to prevent the process from exiting.
     */
    onHavingOneOrMoreOpenCommunication() { }
    // The following snippet is intentionally not a tsdoc (only 1 star as oppose to 2). There is
    // likely a bug in TypeScript that when we change it to tsdoc, on darwin and linux, it causes the
    // generated .d.ts file to be invalid. We have considered reporting this to TypeScript, but it is
    // way too difficult to narrow down, thus we just hope this is the only case that this error
    // occurs.
    /*
     * Called by the client port when the number of open communications changes from 1 or more to 0.
     * This usually indicates the `socket.unref()` should be called to allow the process to exit.
     */
    onHavingNoOpenCommunication() { }
}

const wsAuthenticationResultSchema = zod.z.discriminatedUnion("success", [
    zod.z.object({
        success: zod.z.literal(true),
    }),
    zod.z.object({
        success: zod.z.literal(false),
        error: zod.z.string(),
    }),
]);

var WsClientTransportStatus;
(function (WsClientTransportStatus) {
    WsClientTransportStatus["Disconnected"] = "DISCONNECTED";
    WsClientTransportStatus["Connecting"] = "CONNECTING";
    WsClientTransportStatus["Connected"] = "CONNECTED";
})(WsClientTransportStatus || (WsClientTransportStatus = {}));
class WsClientTransport extends ClientTransport {
    constructor(url, receivedMessage, errored, { abortSignal, parentLogger } = {}) {
        super();
        this.url = url;
        this.receivedMessage = receivedMessage;
        this.errored = errored;
        this.ws = null;
        this.queuedMessages = [];
        this.status = WsClientTransportStatus.Disconnected;
        this.resolvedUrl = null;
        /**
         * Whether the underlying socket should hold the process open.
         */
        this.shouldRef = false;
        this.resolveDisposed = null;
        this.abortSignal = abortSignal;
        this.logger = new SimpleLogger("WsClientTransport", parentLogger);
    }
    static createWsClientTransportFactory(url, { abortSignal, } = {}) {
        return (receivedMessage, errored, parentLogger) => new WsClientTransport(url, receivedMessage, errored, {
            abortSignal,
            parentLogger,
        });
    }
    connect() {
        if (this.status !== WsClientTransportStatus.Disconnected) {
            this.logger.warn("connect() called while not disconnected");
            return;
        }
        if (this.disposed) {
            throw new Error(text `
        Cannot establish WebSocket connection because the transport has been disposed.
      `);
        }
        if (this.abortSignal !== undefined && this.abortSignal.aborted) {
            throw new Error(this.abortSignal.reason);
        }
        this.status = WsClientTransportStatus.Connecting;
        Promise.resolve(this.url).then(url => {
            this.resolvedUrl = url;
            this.ws = new lmsIsomorphic.WebSocket(url);
            this.ws.addEventListener("open", this.onWsOpen.bind(this));
            this.ws.addEventListener("error", event => this.onWsError(event.error));
            this.ws.addEventListener("close", () => {
                this.onWsError(new Error("WebSocket connection closed"));
            });
            const abortSignal = this.abortSignal;
            if (abortSignal !== undefined) {
                if (abortSignal.aborted) {
                    this.onWsError(abortSignal.reason);
                }
                else {
                    const abortListener = () => {
                        this.onWsError(abortSignal.reason);
                    };
                    abortSignal.addEventListener("abort", abortListener, { once: true });
                    this.ws.addEventListener("close", () => {
                        abortSignal.removeEventListener("abort", abortListener);
                    });
                }
            }
        });
    }
    onWsOpen() {
        this.ws.addEventListener("message", this.onWsMessage.bind(this));
        this.status = WsClientTransportStatus.Connected;
        this.queuedMessages.forEach(message => this.sendViaTransport(message));
        this.queuedMessages = [];
        this.updateShouldRef(this.shouldRef);
        // this.setupWebsocketKeepAlive(this.ws!, this.onWsTimeout.bind(this));
    }
    onWsMessage(event) {
        if (this.status !== WsClientTransportStatus.Connected) {
            this.logger.warn("Received message while not connected. Message ignored:", event.data);
            return;
        }
        let message;
        try {
            message = JSON.parse(String(event.data));
        }
        catch (error) {
            this.logger.warn("Received invalid JSON message from server:", event.data);
            return;
        }
        let parsed;
        try {
            parsed = this.parseIncomingMessage(message);
        }
        catch (error) {
            this.logger.warn("Received invalid message from server:", message);
            return;
        }
        this.receivedMessage(parsed);
    }
    onWsError(error) {
        if (this.status === WsClientTransportStatus.Disconnected) {
            return;
        }
        this.logger.warn("WebSocket error:", error);
        if (error.code === "ECONNREFUSED") {
            this.logger.warnText `
        WebSocket connection refused. This can happen if the server is not running or the client
        is trying to connect to the wrong path. The server path that this client is
        attempting to connect to is:
        ${this.resolvedUrl ?? "Unknown" /* Should never be Unknown */}.

        Please make sure the following:

          1. LM Studio is running

          2. The API server in LM Studio has started

          3. The client is attempting to connect to the correct path
      `;
        }
        try {
            this.ws?.close();
        }
        catch (error) {
            // Ignore
        }
        this.status = WsClientTransportStatus.Disconnected;
        this.errored(error);
    }
    onWsTimeout() {
        if (this.status === WsClientTransportStatus.Disconnected) {
            return;
        }
        this.logger.warn("Websocket timed out");
        try {
            this.ws?.close();
        }
        catch (error) {
            // Ignore
        }
        this.status = WsClientTransportStatus.Disconnected;
        this.errored(new Error("WebSocket timed out"));
    }
    onHavingNoOpenCommunication() {
        this.updateShouldRef(false);
        if (this.disposed && this.resolveDisposed !== null) {
            // If the transport is disposed, we can resolve the disposed promise to allow the
            // async dispose to complete.
            this.resolveDisposed();
            this.resolveDisposed = null;
        }
    }
    onHavingOneOrMoreOpenCommunication() {
        this.updateShouldRef(true);
    }
    updateShouldRef(shouldRef) {
        this.shouldRef = shouldRef;
        if (this.ws === null) {
            return;
        }
        if (!this.ws._socket) {
            return;
        }
        if (shouldRef) {
            this.ws._socket.ref();
        }
        else {
            this.ws._socket.unref();
        }
    }
    sendViaTransport(message) {
        if (this.status === WsClientTransportStatus.Connected) {
            this.ws.send(JSON.stringify(message));
        }
        else {
            this.queuedMessages.push(message);
            if (this.status === WsClientTransportStatus.Disconnected) {
                this.connect();
            }
        }
    }
    async [Symbol.asyncDispose]() {
        await super[Symbol.asyncDispose]();
        if (this.shouldRef) {
            // If the connection needs to held up, wait until all communications are terminates
            const { promise: disposedPromise, resolve: resolveDisposed } = makePromise();
            this.resolveDisposed = resolveDisposed;
            await disposedPromise;
        }
        if (this.ws !== null) {
            try {
                this.ws.close();
            }
            catch (error) {
                // Ignore
            }
            this.ws = null;
        }
        this.errored(new Error("WebSocket client transport disposed"));
        this.status = WsClientTransportStatus.Disconnected;
    }
}

class AuthenticatedWsClientTransport extends WsClientTransport {
    constructor(url, clientIdentifier, clientPasskey, receivedMessage, errored, { parentLogger, abortSignal } = {}) {
        super(url, receivedMessage, errored, { parentLogger, abortSignal });
        this.clientIdentifier = clientIdentifier;
        this.clientPasskey = clientPasskey;
        this.logger = this.logger.subclass("AuthenticatedWsClientTransport");
    }
    static createAuthenticatedWsClientTransportFactory({ url, clientIdentifier, clientPasskey, abortSignal, }) {
        return (receivedMessage, errored, parentLogger) => new AuthenticatedWsClientTransport(url, clientIdentifier, clientPasskey, receivedMessage, errored, { parentLogger, abortSignal });
    }
    onWsOpen() {
        this.ws.send(JSON.stringify({
            authVersion: 1,
            clientIdentifier: this.clientIdentifier,
            clientPasskey: this.clientPasskey,
        }));
        this.ws.addEventListener("message", (event) => {
            try {
                const data = JSON.parse(event.data.toString("utf-8"));
                const result = wsAuthenticationResultSchema.parse(data);
                if (result.success) {
                    super.onWsOpen();
                }
                else {
                    this.onWsError(new Error("Failed to authenticate: " + result.error));
                }
            }
            catch (error) {
                this.onWsError(new Error("Failed to parse authentication result: " + error?.message));
            }
        }, {
            once: true,
        });
    }
}

function defaultErrorDeserializer(serialized, directCause, stack) {
    return fromSerializedError(serialized, directCause, stack);
}
class ClientPort {
    constructor(backendInterface, factory, { parentLogger, errorDeserializer, verboseErrorMessage, } = {}) {
        this.backendInterface = backendInterface;
        this.openChannels = new Map();
        this.ongoingRpcs = new Map();
        this.openSignalSubscriptions = new Map();
        this.openWritableSignalSubscriptions = new Map();
        this.openCommunicationsCount = 0;
        this.nextChannelId = 0;
        this.nextSubscribeId = 0;
        this.nextWritableSubscribeId = 0;
        this.producedCommunicationWarningsCount = 0;
        this.receivedMessage = (message) => {
            switch (message.type) {
                case "channelSend": {
                    this.receivedChannelSend(message);
                    break;
                }
                case "channelAck": {
                    this.receivedChannelAck(message);
                    break;
                }
                case "channelClose": {
                    this.receivedChannelClose(message);
                    break;
                }
                case "channelError": {
                    this.receivedChannelError(message);
                    break;
                }
                case "rpcResult": {
                    this.receivedRpcResult(message);
                    break;
                }
                case "rpcError": {
                    this.receivedRpcError(message);
                    break;
                }
                case "signalUpdate": {
                    this.receivedSignalUpdate(message);
                    break;
                }
                case "signalError": {
                    this.receivedSignalError(message);
                    break;
                }
                case "writableSignalUpdate": {
                    this.receivedWritableSignalUpdate(message);
                    break;
                }
                case "writableSignalError": {
                    this.receivedWritableSignalError(message);
                    break;
                }
                case "communicationWarning": {
                    this.receivedCommunicationWarning(message);
                    break;
                }
                case "keepAliveAck": {
                    this.receivedKeepAliveAck(message);
                    break;
                }
            }
        };
        this.errored = (error) => {
            for (const openChannel of this.openChannels.values()) {
                openChannel.errored(error);
            }
            this.openChannels.clear();
            for (const ongoingRpc of this.ongoingRpcs.values()) {
                ongoingRpc.reject(error);
            }
            this.ongoingRpcs.clear();
            for (const openSignalSubscription of this.openSignalSubscriptions.values()) {
                openSignalSubscription.errored(error);
            }
            this.openSignalSubscriptions.clear();
            for (const openWritableSignalSubscription of this.openWritableSignalSubscriptions.values()) {
                openWritableSignalSubscription.errored(error);
            }
            this.openWritableSignalSubscriptions.clear();
            this.updateOpenCommunicationsCount();
        };
        this.logger = new SimpleLogger("ClientPort", parentLogger);
        this.errorDeserializer = errorDeserializer ?? defaultErrorDeserializer;
        this.verboseErrorMessage = verboseErrorMessage ?? true;
        this.transport = factory(this.receivedMessage, this.errored, this.logger);
    }
    communicationWarning(warning) {
        if (this.producedCommunicationWarningsCount >= 5) {
            return;
        }
        this.logger.warnText `
      Produced communication warning: ${warning}
      
      This is usually caused by communication protocol incompatibility. Please make sure you are
      using the up-to-date versions of the SDK and LM Studio.
    `;
        this.transport.send({
            type: "communicationWarning",
            warning,
        });
        this.producedCommunicationWarningsCount++;
        if (this.producedCommunicationWarningsCount >= 5) {
            this.logger.errorText `
        5 communication warnings have been produced. Further warnings will not be printed.
      `;
        }
    }
    updateOpenCommunicationsCount() {
        const previousCount = this.openCommunicationsCount;
        this.openCommunicationsCount =
            this.openChannels.size +
                this.ongoingRpcs.size +
                this.openSignalSubscriptions.size +
                this.openWritableSignalSubscriptions.size;
        if (this.openCommunicationsCount === 0 && previousCount > 0) {
            this.transport.onHavingNoOpenCommunication();
        }
        else if (this.openCommunicationsCount === 1 && previousCount === 0) {
            this.transport.onHavingOneOrMoreOpenCommunication();
        }
    }
    receivedChannelSend(message) {
        const openChannel = this.openChannels.get(message.channelId);
        if (openChannel === undefined) {
            this.communicationWarning(`Received channelSend for unknown channel, channelId = ${message.channelId}`);
            return;
        }
        const deserializedMessage = deserialize(openChannel.endpoint.serialization, message.message);
        const parsed = openChannel.endpoint.toClientPacket.safeParse(deserializedMessage);
        if (!parsed.success) {
            this.communicationWarning(text `
        Received invalid message for channel: endpointName = ${openChannel.endpoint.name}, message =
        ${deserializedMessage}. Zod error:

        ${Validator.prettyPrintZod("message", parsed.error)}
      `);
            return;
        }
        openChannel.receivedMessage(parsed.data);
    }
    receivedChannelAck(message) {
        const openChannel = this.openChannels.get(message.channelId);
        if (openChannel === undefined) {
            this.communicationWarning(`Received channelAck for unknown channel, channelId = ${message.channelId}`);
            return;
        }
        openChannel.receivedAck(message.ackId);
    }
    receivedChannelClose(message) {
        const openChannel = this.openChannels.get(message.channelId);
        if (openChannel === undefined) {
            this.communicationWarning(`Received channelClose for unknown channel, channelId = ${message.channelId}`);
            return;
        }
        this.openChannels.delete(message.channelId);
        openChannel.closed();
        this.updateOpenCommunicationsCount();
    }
    receivedChannelError(message) {
        const openChannel = this.openChannels.get(message.channelId);
        if (openChannel === undefined) {
            this.communicationWarning(`Received channelError for unknown channel, channelId = ${message.channelId}`);
            return;
        }
        this.openChannels.delete(message.channelId);
        const error = this.errorDeserializer(message.error, "Channel Error", this.verboseErrorMessage ? openChannel.stack : undefined);
        openChannel.errored(error);
        this.updateOpenCommunicationsCount();
    }
    receivedRpcResult(message) {
        const ongoingRpc = this.ongoingRpcs.get(message.callId);
        if (ongoingRpc === undefined) {
            this.communicationWarning(`Received rpcResult for unknown rpc, callId = ${message.callId}`);
            return;
        }
        const deserializedResult = deserialize(ongoingRpc.endpoint.serialization, message.result);
        const parsed = ongoingRpc.endpoint.returns.safeParse(deserializedResult);
        if (!parsed.success) {
            this.communicationWarning(text `
        Received invalid result for rpc, endpointName = ${ongoingRpc.endpoint.name}, result =
        ${deserializedResult}. Zod error:

        ${Validator.prettyPrintZod("result", parsed.error)}
      `);
            return;
        }
        ongoingRpc.resolve(parsed.data);
        this.ongoingRpcs.delete(message.callId);
        this.updateOpenCommunicationsCount();
    }
    receivedRpcError(message) {
        const ongoingRpc = this.ongoingRpcs.get(message.callId);
        if (ongoingRpc === undefined) {
            this.communicationWarning(`Received rpcError for unknown rpc, callId = ${message.callId}`);
            return;
        }
        const error = this.errorDeserializer(message.error, "RPC Error", this.verboseErrorMessage ? ongoingRpc.stack : undefined);
        ongoingRpc.reject(error);
        this.ongoingRpcs.delete(message.callId);
        this.updateOpenCommunicationsCount();
    }
    receivedSignalUpdate(message) {
        const openSignalSubscription = this.openSignalSubscriptions.get(message.subscribeId);
        if (openSignalSubscription === undefined) {
            // This is caused by update and unsubscribe event happening at the same time. By the time the
            // update has arrived at the client side, as far as the client is considered, the signal is
            // already unsubscribed. This is a normal behavior and is especially prevalent when React
            // StrictMode is enabled, because components are rendered twice where signals are oftentimes
            // subscribed and then unsubscribed immediately after.
            return;
        }
        const patches = message.patches.map(patch => deserialize(openSignalSubscription.endpoint.serialization, patch));
        const beforeValue = openSignalSubscription.getValue();
        let afterValue;
        try {
            afterValue = applyPatches(beforeValue, patches);
        }
        catch (error) {
            this.communicationWarning(text `
        Failed to apply patches to signal on signalUpdate. subscribeId = ${message.subscribeId}.

        beforeValue = ${JSON.stringify(beforeValue, null, 2)},

        patches = ${JSON.stringify(patches, null, 2)}.

        Error: ${String(error)}
      `);
            return;
        }
        const parseResult = openSignalSubscription.endpoint.signalData.safeParse(afterValue);
        if (!parseResult.success) {
            this.communicationWarning(text `
        Received invalid signal patch data, subscribeId = ${message.subscribeId}

        patches = ${patches},

        beforeValue = ${beforeValue},

        afterValue = ${afterValue}.

        Zod error:

        ${Validator.prettyPrintZod("value", parseResult.error)}
      `);
            return;
        }
        // Don't use the parsed value, as it loses the substructure identities
        openSignalSubscription.receivedPatches(afterValue, patches, message.tags);
    }
    receivedSignalError(message) {
        const openSignalSubscription = this.openSignalSubscriptions.get(message.subscribeId);
        if (openSignalSubscription === undefined) {
            this.communicationWarning(`Received signalError for unknown signal, subscribeId = ${message.subscribeId}`);
            return;
        }
        const error = this.errorDeserializer(message.error, "Signal Error", this.verboseErrorMessage ? openSignalSubscription.stack : undefined);
        openSignalSubscription.errored(error);
        this.openSignalSubscriptions.delete(message.subscribeId);
        this.updateOpenCommunicationsCount();
    }
    receivedWritableSignalUpdate(message) {
        const openSignalSubscription = this.openWritableSignalSubscriptions.get(message.subscribeId);
        if (openSignalSubscription === undefined) {
            // This is caused by update and unsubscribe event happening at the same time. By the time the
            // update has arrived at the client side, as far as the client is considered, the signal is
            // already unsubscribed. This is a normal behavior and is especially prevalent when React
            // StrictMode is enabled, because components are rendered twice where signals are oftentimes
            // subscribed and then unsubscribed immediately after.
            return;
        }
        const patches = message.patches.map(patch => deserialize(openSignalSubscription.endpoint.serialization, patch));
        const beforeValue = openSignalSubscription.getValue();
        let afterValue;
        try {
            afterValue = applyPatches(openSignalSubscription.getValue(), patches);
        }
        catch (error) {
            this.communicationWarning(text `
        Failed to apply patches to writable signal on writableSignalUpdate. subscribeId =
        ${message.subscribeId}.

        beforeValue = ${JSON.stringify(beforeValue, null, 2)},

        patches = ${JSON.stringify(patches, null, 2)}.

        Error: ${String(error)}
      `);
        }
        const parseResult = openSignalSubscription.endpoint.signalData.safeParse(afterValue);
        if (!parseResult.success) {
            this.communicationWarning(text `
        Received invalid writable signal patch data, subscribeId = ${message.subscribeId}

        patches = ${patches},

        beforeValue = ${beforeValue},

        afterValue = ${afterValue}.

        Zod error:

        ${Validator.prettyPrintZod("value", parseResult.error)}
      `);
            return;
        }
        // Don't use the parsed value, as it loses the substructure identities
        openSignalSubscription.firstUpdateReceived = true;
        openSignalSubscription.receivedPatches(afterValue, patches, message.tags);
    }
    receivedWritableSignalError(message) {
        const openSignalSubscription = this.openWritableSignalSubscriptions.get(message.subscribeId);
        if (openSignalSubscription === undefined) {
            this.communicationWarning(`Received writableSignalError for unknown signal, subscribeId = ${message.subscribeId}`);
            return;
        }
        const error = this.errorDeserializer(message.error, "Writable Signal Error", this.verboseErrorMessage ? openSignalSubscription.stack : undefined);
        openSignalSubscription.errored(error);
        this.openWritableSignalSubscriptions.delete(message.subscribeId);
        this.updateOpenCommunicationsCount();
    }
    receivedCommunicationWarning(message) {
        this.logger.warnText `
      Received communication warning from the server: ${message.warning}
      
      This is usually caused by communication protocol incompatibility. Please make sure you are
      using the up-to-date versions of the SDK and LM Studio.

      Note: This warning was received from the server and is printed on the client for convenience.
    `;
    }
    receivedKeepAliveAck(_message) {
        // Do nothing
    }
    async callRpc(endpointName, param, { stack } = {}) {
        const endpoint = this.backendInterface.getRpcEndpoint(endpointName);
        if (endpoint === undefined) {
            throw new Error(`No Rpc endpoint with name ${endpointName}`);
        }
        const parameter = endpoint.parameter.parse(param);
        const serializedParameter = serialize(endpoint.serialization, parameter);
        const callId = this.nextChannelId;
        this.nextChannelId++;
        const { promise, resolve, reject } = makePromise();
        stack = stack ?? getCurrentStack(1);
        this.ongoingRpcs.set(callId, {
            endpoint,
            stack,
            resolve,
            reject,
        });
        this.transport.send({
            type: "rpcCall",
            endpoint: endpointName,
            callId,
            parameter: serializedParameter,
        });
        this.updateOpenCommunicationsCount();
        return await promise;
    }
    createChannel(endpointName, param, onMessage, { stack } = {}) {
        const channelEndpoint = this.backendInterface.getChannelEndpoint(endpointName);
        if (channelEndpoint === undefined) {
            throw new Error(`No channel endpoint with name ${endpointName}`);
        }
        const creationParameter = channelEndpoint.creationParameter.parse(param);
        const serializedCreationParameter = serialize(channelEndpoint.serialization, creationParameter);
        const channelId = this.nextChannelId;
        this.nextChannelId++;
        this.transport.send({
            type: "channelCreate",
            endpoint: endpointName,
            channelId,
            creationParameter: serializedCreationParameter,
        });
        stack = stack ?? getCurrentStack(1);
        const openChannel = {
            endpoint: channelEndpoint,
            stack,
            ...Channel.create(packet => {
                const parsed = channelEndpoint.toServerPacket.parse(packet);
                const serializedMessage = serialize(channelEndpoint.serialization, parsed);
                this.transport.send({
                    type: "channelSend",
                    channelId,
                    message: serializedMessage,
                });
            }),
        };
        if (onMessage !== undefined) {
            openChannel.channel.onMessage.subscribe(onMessage);
        }
        this.openChannels.set(channelId, openChannel);
        this.updateOpenCommunicationsCount();
        return openChannel.channel;
    }
    /**
     * Creates a readonly lazy signal will subscribe to the signal endpoint with the given name.
     */
    createSignal(endpointName, param, { stack } = {}) {
        const signalEndpoint = this.backendInterface.getSignalEndpoint(endpointName);
        if (signalEndpoint === undefined) {
            throw new Error(`No signal endpoint with name ${endpointName}`);
        }
        const creationParameter = signalEndpoint.creationParameter.parse(param);
        const serializedCreationParameter = serialize(signalEndpoint.serialization, creationParameter);
        stack = stack ?? getCurrentStack(1);
        const signal = LazySignal.createWithoutInitialValue((setDownstream, errorListener) => {
            const subscribeId = this.nextSubscribeId;
            this.nextSubscribeId++;
            this.transport.send({
                type: "signalSubscribe",
                endpoint: endpointName,
                subscribeId,
                creationParameter: serializedCreationParameter,
            });
            this.openSignalSubscriptions.set(subscribeId, {
                endpoint: signalEndpoint,
                getValue: () => signal.get(),
                receivedPatches: setDownstream.withValueAndPatches,
                errored: errorListener,
                stack,
            });
            this.updateOpenCommunicationsCount();
            return () => {
                this.transport.send({
                    type: "signalUnsubscribe",
                    subscribeId,
                });
                this.openSignalSubscriptions.delete(subscribeId);
            };
        });
        return signal;
    }
    createWritableSignal(endpointName, param, { stack } = {}) {
        const signalEndpoint = this.backendInterface.getWritableSignalEndpoint(endpointName);
        if (signalEndpoint === undefined) {
            throw new Error(`No writable signal endpoint with name ${endpointName}`);
        }
        const creationParameter = signalEndpoint.creationParameter.parse(param);
        const serializedCreationParameter = serialize(signalEndpoint.serialization, creationParameter);
        stack = stack ?? getCurrentStack(1);
        let currentSubscribeId = null;
        const writeUpstream = (_data, patches, tags) => {
            if (currentSubscribeId === null) {
                console.warn("writeUpstream called when not subscribed");
                return false;
            }
            const subscription = this.openWritableSignalSubscriptions.get(currentSubscribeId);
            if (!subscription?.firstUpdateReceived) {
                console.warn("writeUpstream called before the first update is received");
                return false;
            }
            this.transport.send({
                type: "writableSignalUpdate",
                subscribeId: currentSubscribeId,
                patches: patches.map(patch => serialize(signalEndpoint.serialization, patch)),
                tags,
            });
            return true;
        };
        const [signal, setter] = OWLSignal.createWithoutInitialValue((setDownstream, errorListener) => {
            const subscribeId = this.nextWritableSubscribeId;
            currentSubscribeId = subscribeId;
            this.nextWritableSubscribeId++;
            this.transport.send({
                type: "writableSignalSubscribe",
                endpoint: endpointName,
                subscribeId,
                creationParameter: serializedCreationParameter,
            });
            this.openWritableSignalSubscriptions.set(subscribeId, {
                endpoint: signalEndpoint,
                getValue: () => signal.getPessimistic(),
                receivedPatches: setDownstream.withValueAndPatches,
                firstUpdateReceived: false,
                errored: errorListener,
                stack,
            });
            this.updateOpenCommunicationsCount();
            return () => {
                currentSubscribeId = null;
                this.transport.send({
                    type: "writableSignalUnsubscribe",
                    subscribeId,
                });
                this.openWritableSignalSubscriptions.delete(subscribeId);
            };
        }, writeUpstream);
        return [signal, setter];
    }
    async [Symbol.asyncDispose]() {
        await this.transport[Symbol.asyncDispose]();
    }
}

class GenericClientTransport extends ClientTransport {
    constructor(onMessage, onClose, sendMessage, receivedMessage, errored, parentLogger) {
        super();
        this.sendMessage = sendMessage;
        this.receivedMessage = receivedMessage;
        this.errored = errored;
        this.closed = false;
        this.logger = new SimpleLogger("GenericClientTransport", parentLogger);
        onMessage.subscribe(message => {
            let parsed;
            try {
                parsed = this.parseIncomingMessage(message);
            }
            catch (error) {
                this.logger.warn("Received invalid message from server:", message);
                return;
            }
            this.receivedMessage(parsed);
        });
        onClose.subscribeOnce(() => {
            if (this.closed) {
                return;
            }
            this.closed = true;
            this.errored(new Error("Server closed the connection"));
        });
    }
    static createFactory(onMessage, onClose, sendMessage) {
        return (receivedMessage, errored, parentLogger) => new GenericClientTransport(onMessage, onClose, sendMessage, receivedMessage, errored, parentLogger);
    }
    sendViaTransport(message) {
        this.sendMessage(message);
    }
}

function getHostedEnv() {
    let anyWindow;
    try {
        anyWindow = window;
    }
    catch (error) {
        anyWindow = undefined;
    }
    if (anyWindow !== undefined && anyWindow.lmsHostedEnv !== undefined) {
        return anyWindow.lmsHostedEnv;
    }
    return null;
}

/**
 * Create a base model backend interface that are used by all domain-specific model backend
 * interfaces.
 */
function createBaseModelBackendInterface(specificModelInstanceInfoSchemaInput, specificModelInfoSchemaInput) {
    const specificModelInstanceInfoSchema = specificModelInstanceInfoSchemaInput;
    const specificModelInfoSchema = specificModelInfoSchemaInput;
    return new BackendInterface()
        .addChannelEndpoint("loadModel", {
        creationParameter: zod.z.object({
            modelKey: zod.z.string(),
            identifier: zod.z.string().optional(),
            /**
             * If provided, when the model is not used for this amount of time, it will be unloaded.
             */
            ttlMs: zod.z.number().int().min(1).optional(),
            loadConfigStack: kvConfigStackSchema,
        }),
        toClientPacket: zod.z.discriminatedUnion("type", [
            zod.z.object({
                type: zod.z.literal("resolved"),
                info: specificModelInfoSchema,
                ambiguous: zod.z.array(zod.z.string()).optional(),
            }),
            zod.z.object({
                type: zod.z.literal("progress"),
                progress: zod.z.number(),
            }),
            zod.z.object({
                type: zod.z.literal("success"),
                info: specificModelInstanceInfoSchema,
            }),
        ]),
        toServerPacket: zod.z.discriminatedUnion("type", [
            zod.z.object({
                type: zod.z.literal("cancel"),
            }),
        ]),
    })
        .addRpcEndpoint("unloadModel", {
        parameter: zod.z.object({
            identifier: zod.z.string(),
        }),
        returns: zod.z.void(),
    })
        .addRpcEndpoint("listLoaded", {
        parameter: zod.z.undefined(),
        returns: zod.z.array(specificModelInstanceInfoSchema),
    })
        .addRpcEndpoint("getModelInfo", {
        parameter: zod.z.object({
            specifier: modelSpecifierSchema,
            throwIfNotFound: zod.z.boolean(),
        }),
        returns: specificModelInstanceInfoSchema.optional(),
    })
        .addRpcEndpoint("getLoadConfig", {
        parameter: zod.z.object({
            specifier: modelSpecifierSchema,
        }),
        returns: kvConfigSchema,
    })
        .addChannelEndpoint("getOrLoad", {
        creationParameter: zod.z.object({
            identifier: zod.z.string(),
            /**
             * If provided and a new instance is loaded as a result of this call, it will be unloaded
             * after idling for this amount of time.
             */
            loadTtlMs: zod.z.number().int().min(1).optional(),
            loadConfigStack: kvConfigStackSchema,
        }),
        toClientPacket: zod.z.discriminatedUnion("type", [
            zod.z.object({
                type: zod.z.literal("alreadyLoaded"),
                info: specificModelInstanceInfoSchema,
            }),
            zod.z.object({
                type: zod.z.literal("startLoading"),
                identifier: zod.z.string(),
                info: specificModelInfoSchema,
            }),
            zod.z.object({
                // We are unloading other JIT model
                type: zod.z.literal("unloadingOtherJITModel"),
                info: modelInstanceInfoSchema,
            }),
            zod.z.object({
                type: zod.z.literal("loadProgress"),
                progress: zod.z.number(),
            }),
            zod.z.object({
                type: zod.z.literal("loadSuccess"),
                info: specificModelInstanceInfoSchema,
            }),
        ]),
        toServerPacket: zod.z.discriminatedUnion("type", [
            zod.z.object({
                type: zod.z.literal("cancel"),
            }),
        ]),
    });
}

function createDiagnosticsBackendInterface() {
    return new BackendInterface().addChannelEndpoint("streamLogs", {
        creationParameter: zod.z.void(),
        toServerPacket: zod.z.discriminatedUnion("type", [
            zod.z.object({
                type: zod.z.literal("stop"),
            }),
        ]),
        toClientPacket: zod.z.discriminatedUnion("type", [
            zod.z.object({
                type: zod.z.literal("log"),
                log: diagnosticsLogEventSchema,
            }),
        ]),
    });
}

function createEmbeddingBackendInterface() {
    const baseModelBackendInterface = createBaseModelBackendInterface(embeddingModelInstanceInfoSchema, embeddingModelInfoSchema);
    return baseModelBackendInterface
        .addRpcEndpoint("embedString", {
        parameter: zod.z.object({
            modelSpecifier: modelSpecifierSchema,
            inputString: zod.z.string(),
        }),
        returns: zod.z.object({
            embedding: zod.z.array(zod.z.number()),
        }),
    })
        .addRpcEndpoint("tokenize", {
        parameter: zod.z.object({
            specifier: modelSpecifierSchema,
            inputString: zod.z.string(),
        }),
        returns: zod.z.object({
            tokens: zod.z.array(zod.z.number()),
        }),
    })
        .addRpcEndpoint("countTokens", {
        parameter: zod.z.object({
            specifier: modelSpecifierSchema,
            inputString: zod.z.string(),
        }),
        returns: zod.z.object({
            tokenCount: zod.z.number().int(),
        }),
    });
}

function createFilesBackendInterface() {
    return new BackendInterface()
        .addRpcEndpoint("getLocalFileAbsolutePath", {
        parameter: zod.z.object({
            fileName: zod.z.string(),
        }),
        returns: zod.z.object({
            path: zod.z.string(),
        }),
    })
        .addRpcEndpoint("uploadFileBase64", {
        parameter: zod.z.object({
            name: zod.z.string(),
            contentBase64: zod.z.string(),
        }),
        returns: zod.z.object({
            identifier: zod.z.string(),
            fileType: fileTypeSchema,
            sizeBytes: zod.z.number().int(),
        }),
    })
        .addChannelEndpoint("retrieve", {
        creationParameter: zod.z.object({
            query: zod.z.string(),
            fileIdentifiers: zod.z.array(zod.z.string()),
            config: kvConfigSchema,
        }),
        toServerPacket: zod.z.discriminatedUnion("type", [
            zod.z.object({
                type: zod.z.literal("stop"),
            }),
        ]),
        toClientPacket: zod.z.discriminatedUnion("type", [
            zod.z.object({
                type: zod.z.literal("onFileProcessList"),
                indices: zod.z.array(zod.z.number().int()),
            }),
            zod.z.object({
                type: zod.z.literal("onFileProcessingStart"),
                index: zod.z.number().int(),
            }),
            zod.z.object({
                type: zod.z.literal("onFileProcessingEnd"),
                index: zod.z.number().int(),
            }),
            zod.z.object({
                type: zod.z.literal("onFileProcessingStepStart"),
                index: zod.z.number().int(),
                step: retrievalFileProcessingStepSchema,
            }),
            zod.z.object({
                type: zod.z.literal("onFileProcessingStepProgress"),
                index: zod.z.number().int(),
                step: retrievalFileProcessingStepSchema,
                progress: zod.z.number(),
            }),
            zod.z.object({
                type: zod.z.literal("onFileProcessingStepEnd"),
                index: zod.z.number().int(),
                step: retrievalFileProcessingStepSchema,
            }),
            zod.z.object({
                type: zod.z.literal("onSearchingStart"),
            }),
            zod.z.object({
                type: zod.z.literal("onSearchingEnd"),
            }),
            zod.z.object({
                type: zod.z.literal("result"),
                result: internalRetrievalResultSchema,
            }),
        ]),
    })
        .addChannelEndpoint("parseDocument", {
        creationParameter: zod.z.object({
            fileIdentifier: zod.z.string(),
            parseOpts: documentParsingOptsSchema,
        }),
        toClientPacket: zod.z.discriminatedUnion("type", [
            zod.z.object({
                type: zod.z.literal("parserLoaded"),
                parser: documentParsingLibraryIdentifierSchema,
            }),
            zod.z.object({
                type: zod.z.literal("progress"),
                progress: zod.z.number(),
            }),
            zod.z.object({
                type: zod.z.literal("result"),
                content: zod.z.string(),
                parser: documentParsingLibraryIdentifierSchema,
            }),
        ]),
        toServerPacket: zod.z.discriminatedUnion("type", [
            zod.z.object({
                type: zod.z.literal("cancel"),
            }),
        ]),
    })
        .addRpcEndpoint("getDocumentParsingLibrary", {
        parameter: zod.z.object({
            fileIdentifier: zod.z.string(),
        }),
        returns: zod.z.object({
            library: zod.z.string(),
            version: zod.z.string(),
        }),
    });
}

function createLlmBackendInterface() {
    const baseModelBackendInterface = createBaseModelBackendInterface(llmInstanceInfoSchema, llmInfoSchema);
    return (baseModelBackendInterface
        .addChannelEndpoint("predict", {
        creationParameter: zod.z.object({
            modelSpecifier: modelSpecifierSchema,
            history: chatHistoryDataSchema,
            predictionConfigStack: kvConfigStackSchema,
            /**
             * Which preset to use. Supports limited fuzzy matching.
             */
            fuzzyPresetIdentifier: zod.z.string().optional(),
            ignoreServerSessionConfig: zod.z.boolean().optional(),
        }),
        toClientPacket: zod.z.discriminatedUnion("type", [
            zod.z.object({
                type: zod.z.literal("fragment"),
                fragment: llmPredictionFragmentSchema,
                logprobs: zod.z
                    .array(zod.z.array(zod.z.object({ text: zod.z.string(), logprob: zod.z.number() })))
                    .optional(),
            }),
            zod.z.object({
                type: zod.z.literal("promptProcessingProgress"),
                progress: zod.z.number(),
            }),
            zod.z.object({
                type: zod.z.literal("toolCallGenerationStart"),
                /**
                 * The LLM specific call id of the tool call.
                 */
                toolCallId: zod.z.string().optional(),
            }),
            zod.z.object({
                type: zod.z.literal("toolCallGenerationNameReceived"),
                name: zod.z.string(),
            }),
            zod.z.object({
                type: zod.z.literal("toolCallGenerationArgumentFragmentGenerated"),
                content: zod.z.string(),
            }),
            zod.z.object({
                type: zod.z.literal("toolCallGenerationEnd"),
                toolCallRequest: toolCallRequestSchema,
                /**
                 * The raw output that represents this tool call. It is recommended to present this to
                 * the user as is, if desired.
                 *
                 * @remarks It is not guaranteed to be valid JSON as the model does not necessarily use
                 * JSON to represent tool calls.
                 */
                rawContent: zod.z.string().optional(),
            }),
            zod.z.object({
                type: zod.z.literal("toolCallGenerationFailed"),
                error: serializedLMSExtendedErrorSchema,
                /**
                 * The raw output that was generated by the model before the tool call. The exact nature
                 * of this fields depends on the error. It sometimes include the entire tool calls
                 * section, or sometimes just the single tool call that failed.
                 *
                 * It is recommended to present this to the user as is, if desired.
                 */
                rawContent: zod.z.string().optional(),
            }),
            zod.z.object({
                type: zod.z.literal("success"),
                stats: llmPredictionStatsSchema,
                modelInfo: llmInstanceInfoSchema,
                loadModelConfig: kvConfigSchema,
                predictionConfig: kvConfigSchema,
            }),
        ]),
        toServerPacket: zod.z.discriminatedUnion("type", [
            zod.z.object({
                type: zod.z.literal("cancel"),
            }),
        ]),
    })
        .addRpcEndpoint("applyPromptTemplate", {
        parameter: zod.z.object({
            specifier: modelSpecifierSchema,
            history: chatHistoryDataSchema,
            predictionConfigStack: kvConfigStackSchema,
            opts: llmApplyPromptTemplateOptsSchema,
        }),
        returns: zod.z.object({
            formatted: zod.z.string(),
        }),
    })
        .addRpcEndpoint("tokenize", {
        parameter: zod.z.object({
            specifier: modelSpecifierSchema,
            inputString: zod.z.string(),
        }),
        returns: zod.z.object({
            tokens: zod.z.array(zod.z.number()),
        }),
    })
        .addRpcEndpoint("countTokens", {
        parameter: zod.z.object({
            specifier: modelSpecifierSchema,
            inputString: zod.z.string(),
        }),
        returns: zod.z.object({
            tokenCount: zod.z.number().int(),
        }),
    })
        // Starts to eagerly preload a draft model. This is useful when you want a draft model to be
        // ready for speculative decoding.
        .addRpcEndpoint("preloadDraftModel", {
        parameter: zod.z.object({
            specifier: modelSpecifierSchema,
            draftModelKey: zod.z.string(),
        }),
        returns: zod.z.void(),
    }));
}

function createPluginsBackendInterface() {
    return (new BackendInterface()
        /**
         * The following method is called by a client that wants to use plugins that are registered
         * to LM Studio.
         */
        .addChannelEndpoint("startToolUseSession", {
        creationParameter: zod.z.object({
            pluginIdentifier: zod.z.string(),
            pluginConfigSpecifier: pluginConfigSpecifierSchema,
        }),
        toClientPacket: zod.z.discriminatedUnion("type", [
            /**
             * The session has been started successfully. The client can now use the session. Note,
             * there are no sessionError message because if a session fails to start, the channel
             * will error instead.
             */
            zod.z.object({
                type: zod.z.literal("sessionReady"),
                toolDefinitions: zod.z.array(llmToolSchema),
            }),
            /**
             * A tool call has been completed.
             */
            zod.z.object({
                type: zod.z.literal("toolCallComplete"),
                callId: zod.z.number(),
                result: jsonSerializableSchema,
            }),
            /**
             * A tool call has failed.
             */
            zod.z.object({
                type: zod.z.literal("toolCallError"),
                callId: zod.z.number(),
                error: serializedLMSExtendedErrorSchema,
            }),
            /**
             * Status update for a tool call.
             */
            zod.z.object({
                type: zod.z.literal("toolCallStatus"),
                callId: zod.z.number(),
                statusText: zod.z.string(),
            }),
            /**
             * Warning message for a tool call.
             */
            zod.z.object({
                type: zod.z.literal("toolCallWarn"),
                callId: zod.z.number(),
                warnText: zod.z.string(),
            }),
        ]),
        toServerPacket: zod.z.discriminatedUnion("type", [
            /**
             * Request to start a tool call. This call can be aborted using the `abortToolCall`
             * packet. When the tool call is completed, either the `toolCallResult` or `toolCallError`
             * packet will be sent.
             */
            zod.z.object({
                type: zod.z.literal("callTool"),
                callId: zod.z.number(),
                name: zod.z.string(),
                arguments: jsonSerializableSchema,
            }),
            /**
             * Request to abort a tool call. Upon calling this, no toolCallComplete or toolCallError
             * packets will be sent for the call. We assume abort is done immediately.
             */
            zod.z.object({
                type: zod.z.literal("abortToolCall"),
                callId: zod.z.number(),
            }),
            /**
             * Client requests to discard the session. Upon calling this, the channel will be closed.
             */
            zod.z.object({
                type: zod.z.literal("discardSession"),
            }),
        ]),
    })
        .addChannelEndpoint("generateWithGenerator", {
        creationParameter: zod.z.object({
            pluginIdentifier: zod.z.string(),
            pluginConfigSpecifier: pluginConfigSpecifierSchema,
            tools: zod.z.array(llmToolSchema),
            history: chatHistoryDataSchema,
        }),
        toClientPacket: zod.z.discriminatedUnion("type", [
            zod.z.object({
                type: zod.z.literal("fragment"),
                fragment: llmPredictionFragmentSchema,
            }),
            zod.z.object({
                type: zod.z.literal("promptProcessingProgress"),
                progress: zod.z.number(),
            }),
            zod.z.object({
                type: zod.z.literal("toolCallGenerationStart"),
                /**
                 * The LLM specific call id of the tool call.
                 */
                toolCallId: zod.z.string().optional(),
            }),
            zod.z.object({
                type: zod.z.literal("toolCallGenerationNameReceived"),
                name: zod.z.string(),
            }),
            zod.z.object({
                type: zod.z.literal("toolCallGenerationArgumentFragmentGenerated"),
                content: zod.z.string(),
            }),
            zod.z.object({
                type: zod.z.literal("toolCallGenerationEnd"),
                toolCallRequest: toolCallRequestSchema,
            }),
            zod.z.object({
                type: zod.z.literal("toolCallGenerationFailed"),
            }),
            zod.z.object({
                type: zod.z.literal("success"),
            }),
        ]),
        toServerPacket: zod.z.discriminatedUnion("type", [
            zod.z.object({
                type: zod.z.literal("cancel"),
            }),
        ]),
    })
        /**
         * The following method is called by the controlling client. (e.g. lms-cli)
         */
        .addChannelEndpoint("registerDevelopmentPlugin", {
        creationParameter: zod.z.object({
            manifest: pluginManifestSchema,
        }),
        toClientPacket: zod.z.discriminatedUnion("type", [
            zod.z.object({
                type: zod.z.literal("ready"),
                clientIdentifier: zod.z.string(),
                clientPasskey: zod.z.string(),
            }),
        ]),
        toServerPacket: zod.z.discriminatedUnion("type", [
            zod.z.object({
                type: zod.z.literal("end"),
            }),
        ]),
    })
        .addRpcEndpoint("reindexPlugins", {
        parameter: zod.z.void(),
        returns: zod.z.void(),
    })
        /**
         * The following method is called by the plugin client. (plugin:*)
         */
        .addChannelEndpoint("setPromptPreprocessor", {
        creationParameter: zod.z.void(),
        toClientPacket: zod.z.discriminatedUnion("type", [
            zod.z.object({
                type: zod.z.literal("preprocess"),
                taskId: zod.z.string(),
                input: chatMessageDataSchema,
                config: kvConfigSchema,
                pluginConfig: kvConfigSchema,
                globalPluginConfig: kvConfigSchema,
                workingDirectoryPath: zod.z.string().nullable(),
                /**
                 * An array of all the plugins that are enabled for this prediction.
                 */
                enabledPluginInfos: zod.z.array(remotePluginInfoSchema),
                /** Processing Context Identifier */
                pci: zod.z.string(),
                token: zod.z.string(),
            }),
            zod.z.object({
                type: zod.z.literal("abort"),
                taskId: zod.z.string(),
            }),
        ]),
        toServerPacket: zod.z.discriminatedUnion("type", [
            zod.z.object({
                type: zod.z.literal("complete"),
                taskId: zod.z.string(),
                processed: chatMessageDataSchema,
            }),
            zod.z.object({
                type: zod.z.literal("aborted"),
                taskId: zod.z.string(),
            }),
            zod.z.object({
                type: zod.z.literal("error"),
                taskId: zod.z.string(),
                error: serializedLMSExtendedErrorSchema,
            }),
        ]),
    })
        .addChannelEndpoint("setPredictionLoopHandler", {
        creationParameter: zod.z.void(),
        toClientPacket: zod.z.discriminatedUnion("type", [
            zod.z.object({
                type: zod.z.literal("handlePredictionLoop"),
                taskId: zod.z.string(),
                config: kvConfigSchema,
                pluginConfig: kvConfigSchema,
                globalPluginConfig: kvConfigSchema,
                workingDirectoryPath: zod.z.string().nullable(),
                /**
                 * An array of all the plugins that are enabled for this prediction.
                 */
                enabledPluginInfos: zod.z.array(remotePluginInfoSchema),
                /** Processing Context Identifier */
                pci: zod.z.string(),
                token: zod.z.string(),
            }),
            zod.z.object({
                type: zod.z.literal("abort"),
                taskId: zod.z.string(),
            }),
        ]),
        toServerPacket: zod.z.discriminatedUnion("type", [
            zod.z.object({
                type: zod.z.literal("complete"),
                taskId: zod.z.string(),
            }),
            zod.z.object({
                type: zod.z.literal("aborted"),
                taskId: zod.z.string(),
            }),
            zod.z.object({
                type: zod.z.literal("error"),
                taskId: zod.z.string(),
                error: serializedLMSExtendedErrorSchema,
            }),
        ]),
    })
        .addChannelEndpoint("setToolsProvider", {
        creationParameter: zod.z.void(),
        toClientPacket: zod.z.discriminatedUnion("type", [
            /**
             * Starts a "tool providing session". Once this is received, the plugin should call the
             * tools provider and pass the tools to the server using the `sessionInitialized` packet.
             *
             * If the initialization failed, the plugin should send the `sessionInitializationFailed`
             * packet.
             */
            zod.z.object({
                type: zod.z.literal("initSession"),
                pluginConfig: kvConfigSchema,
                globalPluginConfig: kvConfigSchema,
                workingDirectoryPath: zod.z.string().nullable(),
                sessionId: zod.z.string(),
            }),
            zod.z.object({
                type: zod.z.literal("discardSession"),
                sessionId: zod.z.string(),
            }),
            /**
             * Call a tool within a session. The plugin should call the tool and return the result
             * using the `toolCallComplete` packet.
             *
             * If the tool call fails in an unrecoverable way the plugin can send the `toolCallError`
             * packet.
             */
            zod.z.object({
                type: zod.z.literal("callTool"),
                sessionId: zod.z.string(),
                callId: zod.z.string(),
                toolName: zod.z.string(),
                parameters: jsonSerializableSchema,
            }),
            /**
             * Abort a tool call. The plugin should abort the tool call and confirm the abort using
             * the `toolCallAborted` packet.
             */
            zod.z.object({
                type: zod.z.literal("abortToolCall"),
                sessionId: zod.z.string(),
                callId: zod.z.string(),
            }),
        ]),
        toServerPacket: zod.z.discriminatedUnion("type", [
            /**
             * The plugin has provided a list of tools in a new session.
             */
            zod.z.object({
                type: zod.z.literal("sessionInitialized"),
                sessionId: zod.z.string(),
                toolDefinitions: zod.z.array(llmToolSchema),
            }),
            zod.z.object({
                type: zod.z.literal("sessionInitializationFailed"),
                sessionId: zod.z.string(),
                error: serializedLMSExtendedErrorSchema,
            }),
            zod.z.object({
                type: zod.z.literal("toolCallComplete"),
                sessionId: zod.z.string(),
                callId: zod.z.string(),
                result: jsonSerializableSchema,
            }),
            zod.z.object({
                type: zod.z.literal("toolCallError"),
                sessionId: zod.z.string(),
                callId: zod.z.string(),
                error: serializedLMSExtendedErrorSchema,
            }),
            zod.z.object({
                type: zod.z.literal("toolCallStatus"),
                sessionId: zod.z.string(),
                callId: zod.z.string(),
                statusText: zod.z.string(),
            }),
            zod.z.object({
                type: zod.z.literal("toolCallWarn"),
                sessionId: zod.z.string(),
                callId: zod.z.string(),
                warnText: zod.z.string(),
            }),
        ]),
    })
        .addChannelEndpoint("setGenerator", {
        creationParameter: zod.z.void(),
        toClientPacket: zod.z.discriminatedUnion("type", [
            zod.z.object({
                type: zod.z.literal("generate"),
                taskId: zod.z.string(),
                input: chatHistoryDataSchema,
                pluginConfig: kvConfigSchema,
                globalPluginConfig: kvConfigSchema,
                toolDefinitions: zod.z.array(llmToolSchema),
                workingDirectoryPath: zod.z.string().nullable(),
            }),
            zod.z.object({
                type: zod.z.literal("abort"),
                taskId: zod.z.string(),
            }),
        ]),
        toServerPacket: zod.z.discriminatedUnion("type", [
            zod.z.object({
                type: zod.z.literal("complete"),
                taskId: zod.z.string(),
            }),
            zod.z.object({
                type: zod.z.literal("aborted"),
                taskId: zod.z.string(),
            }),
            zod.z.object({
                type: zod.z.literal("error"),
                taskId: zod.z.string(),
                error: serializedLMSExtendedErrorSchema,
            }),
            zod.z.object({
                type: zod.z.literal("fragmentGenerated"),
                taskId: zod.z.string(),
                content: zod.z.string(),
                opts: llmPredictionFragmentInputOptsSchema,
            }),
            zod.z.object({
                type: zod.z.literal("toolCallGenerationStarted"),
                taskId: zod.z.string(),
                toolCallId: zod.z.string().optional(),
            }),
            zod.z.object({
                type: zod.z.literal("toolCallGenerationNameReceived"),
                taskId: zod.z.string(),
                toolName: zod.z.string(),
            }),
            zod.z.object({
                type: zod.z.literal("toolCallGenerationArgumentFragmentGenerated"),
                taskId: zod.z.string(),
                content: zod.z.string(),
            }),
            zod.z.object({
                type: zod.z.literal("toolCallGenerationEnded"),
                taskId: zod.z.string(),
                toolCallRequest: toolCallRequestSchema,
            }),
            zod.z.object({
                type: zod.z.literal("toolCallGenerationFailed"),
                taskId: zod.z.string(),
                error: serializedLMSExtendedErrorSchema,
            }),
        ]),
    })
        .addRpcEndpoint("processingHandleUpdate", {
        parameter: zod.z.object({
            /** Processing Context Identifier */
            pci: zod.z.string(),
            token: zod.z.string(),
            update: processingUpdateSchema,
        }),
        returns: zod.z.void(),
    })
        .addRpcEndpoint("processingHandleRequest", {
        parameter: zod.z.object({
            /** Processing Context Identifier */
            pci: zod.z.string(),
            token: zod.z.string(),
            request: processingRequestSchema,
        }),
        returns: zod.z.object({
            response: processingRequestResponseSchema,
        }),
    })
        .addRpcEndpoint("processingPullHistory", {
        parameter: zod.z.object({
            /** Processing Context Identifier */
            pci: zod.z.string(),
            token: zod.z.string(),
            includeCurrent: zod.z.boolean(),
        }),
        returns: chatHistoryDataSchema,
    })
        .addRpcEndpoint("processingGetOrLoadTokenSource", {
        parameter: zod.z.object({
            /** Processing Context Identifier */
            pci: zod.z.string(),
            token: zod.z.string(),
        }),
        returns: zod.z.object({
            tokenSourceIdentifier: tokenSourceIdentifierSchema,
        }),
    })
        .addRpcEndpoint("processingHasStatus", {
        parameter: zod.z.object({
            /** Processing Context Identifier */
            pci: zod.z.string(),
            token: zod.z.string(),
        }),
        returns: zod.z.boolean(),
    })
        .addRpcEndpoint("processingNeedsNaming", {
        parameter: zod.z.object({
            /** Processing Context Identifier */
            pci: zod.z.string(),
            token: zod.z.string(),
        }),
        returns: zod.z.boolean(),
    })
        .addRpcEndpoint("processingSuggestName", {
        parameter: zod.z.object({
            /** Processing Context Identifier */
            pci: zod.z.string(),
            token: zod.z.string(),
            name: zod.z.string(),
        }),
        returns: zod.z.void(),
    })
        .addRpcEndpoint("processingSetSenderName", {
        parameter: zod.z.object({
            /** Processing Context Identifier */
            pci: zod.z.string(),
            token: zod.z.string(),
            name: zod.z.string(),
        }),
        returns: zod.z.void(),
    })
        .addRpcEndpoint("setConfigSchematics", {
        parameter: zod.z.object({
            schematics: serializedKVConfigSchematicsSchema,
        }),
        returns: zod.z.void(),
    })
        .addRpcEndpoint("setGlobalConfigSchematics", {
        parameter: zod.z.object({
            schematics: serializedKVConfigSchematicsSchema,
        }),
        returns: zod.z.void(),
    })
        .addRpcEndpoint("pluginInitCompleted", {
        parameter: zod.z.void(),
        returns: zod.z.void(),
    }));
}

function createRepositoryBackendInterface() {
    return (new BackendInterface()
        .addRpcEndpoint("searchModels", {
        parameter: zod.z.object({
            opts: modelSearchOptsSchema,
        }),
        returns: zod.z.object({
            results: zod.z.array(modelSearchResultEntryDataSchema),
        }),
    })
        .addRpcEndpoint("getModelDownloadOptions", {
        parameter: zod.z.object({
            modelSearchResultIdentifier: modelSearchResultIdentifierSchema,
        }),
        returns: zod.z.object({
            results: zod.z.array(modelSearchResultDownloadOptionDataSchema),
        }),
    })
        .addChannelEndpoint("downloadModel", {
        creationParameter: zod.z.object({
            downloadIdentifier: zod.z.string(),
        }),
        toClientPacket: zod.z.discriminatedUnion("type", [
            zod.z.object({
                type: zod.z.literal("downloadProgress"),
                update: downloadProgressUpdateSchema,
            }),
            zod.z.object({
                type: zod.z.literal("startFinalizing"),
            }),
            zod.z.object({
                type: zod.z.literal("success"),
                defaultIdentifier: zod.z.string(),
            }),
        ]),
        toServerPacket: zod.z.discriminatedUnion("type", [
            zod.z.object({
                type: zod.z.literal("cancel"),
            }),
        ]),
    })
        /**
         * Downloads one singular artifact at a certain revision. Ignore dependencies.
         */
        .addChannelEndpoint("downloadArtifact", {
        creationParameter: zod.z.object({
            artifactOwner: kebabCaseSchema,
            artifactName: kebabCaseWithDotsSchema,
            revisionNumber: zod.z.number().int().nullable(),
            path: zod.z.string(),
        }),
        toClientPacket: zod.z.discriminatedUnion("type", [
            zod.z.object({
                type: zod.z.literal("downloadProgress"),
                update: downloadProgressUpdateSchema,
            }),
            zod.z.object({
                type: zod.z.literal("startFinalizing"),
            }),
            zod.z.object({
                type: zod.z.literal("success"),
            }),
        ]),
        toServerPacket: zod.z.discriminatedUnion("type", [
            zod.z.object({
                type: zod.z.literal("cancel"),
            }),
        ]),
    })
        .addRpcEndpoint("installPluginDependencies", {
        parameter: zod.z.object({
            pluginFolder: zod.z.string(),
        }),
        returns: zod.z.void(),
    })
        /**
         * Given the path to a local artifact folder, returns the list of files in that folder that
         * would be pushed when invoking the pushArtifact endpoint.
         */
        .addRpcEndpoint("getLocalArtifactFiles", {
        parameter: zod.z.object({
            path: zod.z.string(),
        }),
        returns: zod.z.object({
            fileList: localArtifactFileListSchema,
        }),
    })
        .addChannelEndpoint("pushArtifact", {
        creationParameter: zod.z.object({
            path: zod.z.string(),
            description: zod.z.string().max(1000).optional(),
            /**
             * Request to make the artifact private. Only effective if the artifact did not exist
             * before. Will not change the visibility of an existing artifact.
             */
            makePrivate: zod.z.boolean().optional(),
            /**
             * If true, will write the revision number of the artifact after the push back to the
             * artifact manifest.json.
             */
            writeRevision: zod.z.boolean().optional(),
            overrides: jsonSerializableSchema.optional(),
        }),
        toServerPacket: zod.z.void(),
        toClientPacket: zod.z.discriminatedUnion("type", [
            zod.z.object({
                type: zod.z.literal("message"),
                message: zod.z.string(),
            }),
        ]),
    })
        .addChannelEndpoint("ensureAuthenticated", {
        creationParameter: zod.z.void(),
        toServerPacket: zod.z.void(),
        toClientPacket: zod.z.discriminatedUnion("type", [
            zod.z.object({
                type: zod.z.literal("authenticationUrl"),
                url: zod.z.string(),
            }),
            zod.z.object({
                type: zod.z.literal("authenticated"),
            }),
        ]),
    })
        .addRpcEndpoint("loginWithPreAuthenticatedKeys", {
        parameter: zod.z.object({
            keyId: zod.z.string(),
            publicKey: zod.z.string(),
            privateKey: zod.z.string(),
        }),
        returns: zod.z.object({
            userName: zod.z.string(),
        }),
    })
        /**
         * Given the owner and name of an artifact, creates a download plan for the artifact. Throws
         * an error is the artifact is not found.
         */
        .addChannelEndpoint("createArtifactDownloadPlan", {
        creationParameter: zod.z.object({
            owner: kebabCaseSchema,
            name: kebabCaseWithDotsSchema,
        }),
        toServerPacket: zod.z.discriminatedUnion("type", [
            /**
             * If called before committing the plan, the plan is aborted. If called after committing
             * the plan, the download is canceled.
             */
            zod.z.object({
                type: zod.z.literal("cancel"),
            }),
            /**
             * Can only be called after plan ready. Once called, starts the plan.
             */
            zod.z.object({
                type: zod.z.literal("commit"),
            }),
        ]),
        toClientPacket: zod.z.discriminatedUnion("type", [
            zod.z.object({
                type: zod.z.literal("planUpdated"),
                plan: artifactDownloadPlanSchema,
            }),
            zod.z.object({
                type: zod.z.literal("planReady"),
                plan: artifactDownloadPlanSchema,
            }),
            zod.z.object({
                type: zod.z.literal("downloadProgress"),
                update: downloadProgressUpdateSchema,
            }),
            zod.z.object({
                type: zod.z.literal("startFinalizing"),
            }),
            zod.z.object({
                type: zod.z.literal("success"),
            }),
        ]),
    }));
}

function createSystemBackendInterface() {
    return (new BackendInterface()
        .addRpcEndpoint("listDownloadedModels", {
        parameter: zod.z.void(),
        returns: zod.z.array(modelInfoSchema),
    })
        .addChannelEndpoint("alive", {
        creationParameter: zod.z.void(),
        toServerPacket: zod.z.void(),
        toClientPacket: zod.z.void(),
    })
        .addRpcEndpoint("notify", {
        parameter: backendNotificationSchema,
        returns: zod.z.void(),
    })
        /**
         * Get the LM Studio version
         */
        .addRpcEndpoint("version", {
        parameter: zod.z.void(),
        returns: zod.z.object({
            /**
             * `major.minor.patch`
             */
            version: zod.z.string(),
            /**
             * LM Studio build number
             */
            build: zod.z.number(),
        }),
    })
        .addRpcEndpoint("setExperimentFlag", {
        parameter: zod.z.object({
            code: zod.z.string(),
            value: zod.z.boolean(),
        }),
        returns: zod.z.void(),
    })
        .addRpcEndpoint("getExperimentFlags", {
        parameter: zod.z.void(),
        returns: zod.z.array(zod.z.string()),
    })
        .addRpcEndpoint("startHttpServer", {
        parameter: zod.z.object({
            port: zod.z.number().int().min(1).max(65535).optional(),
            cors: zod.z.boolean().optional(),
        }),
        returns: zod.z.void(),
    })
        .addRpcEndpoint("stopHttpServer", {
        parameter: zod.z.void(),
        returns: zod.z.void(),
    }));
}

function createAuthenticatedIpcTransportFactory(apiNamespace, hostedEnv, clientIdentifier, clientPasskey) {
    const [onMessage, emitOnMessage] = BufferedEvent.create();
    const [onClose, emitOnClose] = BufferedEvent.create();
    const sendToServer = hostedEnv.getApiIpcTunnel(apiNamespace, {
        authVersion: 1,
        clientIdentifier: clientIdentifier,
        clientPasskey: clientPasskey,
    }, emitOnMessage, emitOnClose);
    return GenericClientTransport.createFactory(onMessage, onClose, sendToServer);
}
function createAuthenticatedWsTransportFactory(apiNamespace, wsAddress, clientIdentifier, clientPasskey) {
    return AuthenticatedWsClientTransport.createAuthenticatedWsClientTransportFactory({
        url: Promise.resolve(wsAddress).then(wsAddress => `${wsAddress}/${apiNamespace}`),
        clientIdentifier: clientIdentifier,
        clientPasskey: clientPasskey,
    });
}
function createAuthenticatedClientPort(backendInterface, wsAddress, apiNamespace, clientIdentifier, clientPasskey, logger, { errorDeserializer, verboseErrorMessage, } = {}) {
    const hostedEnv = getHostedEnv();
    if (hostedEnv !== null) {
        if (wsAddress !== undefined) {
            logger.debug("Ignoring wsAddress parameter when constructing the client because the client is" +
                " running in a hosted environment. This is not an error.");
        }
        return new ClientPort(backendInterface, createAuthenticatedIpcTransportFactory(apiNamespace, hostedEnv, clientIdentifier, clientPasskey), { parentLogger: logger, errorDeserializer, verboseErrorMessage });
    }
    else {
        return new ClientPort(backendInterface, createAuthenticatedWsTransportFactory(apiNamespace, wsAddress, clientIdentifier, clientPasskey), { parentLogger: logger, errorDeserializer, verboseErrorMessage });
    }
}

/** @public */
class DiagnosticsNamespace {
    /** @internal */
    constructor(diagnosticsPort, validator, parentLogger) {
        this.diagnosticsPort = diagnosticsPort;
        this.validator = validator;
        this.logger = new SimpleLogger("Diagnostics", parentLogger);
    }
    /**
     * Register a callback to receive log events. Return a function to stop receiving log events.
     *
     * This method is in alpha. Do not use this method in production yet.
     * @alpha
     */
    unstable_streamLogs(listener) {
        const stack = getCurrentStack(1);
        this.validator.validateMethodParamOrThrow("client.diagnostics", "unstable_streamLogs", "listener", zod.z.function(), listener, stack);
        const channel = this.diagnosticsPort.createChannel("streamLogs", undefined, undefined, {
            stack,
        });
        const unsubscribe = channel.onMessage.subscribe(message => {
            if (message.type === "log") {
                listener(message.log);
            }
        });
        return () => {
            unsubscribe();
            channel.send({
                type: "stop",
            });
        };
    }
}

function makeLoadModelOptsSchema(loadModelConfigSchema) {
    return zod.z.object({
        identifier: zod.z.string().optional(),
        config: loadModelConfigSchema.optional(),
        signal: zod.z.instanceof(AbortSignal).optional(),
        ttl: zod.z.number().optional(),
        verbose: zod.z.union([zod.z.boolean(), logLevelSchema]).optional(),
        onProgress: zod.z.function().optional(),
    });
}
/**
 * Abstract namespace for namespaces that deal with models.
 *
 * @public
 */
class ModelNamespace {
    /** @internal */
    getLoadModelOptsSchema() {
        if (this.loadModelOptsSchema === null) {
            this.loadModelOptsSchema = makeLoadModelOptsSchema(this.loadModelConfigSchema);
        }
        return this.loadModelOptsSchema;
    }
    /** @internal */
    constructor(
    /** @internal */
    client, 
    /** @internal */
    port, 
    /** @internal */
    logger, 
    /** @internal */
    validator) {
        this.client = client;
        this.port = port;
        this.logger = logger;
        this.validator = validator;
        /** @internal */
        this.loadModelOptsSchema = null;
    }
    /**
     * Load a model for inferencing. The first parameter is the model key. The second parameter is an
     * optional object with additional options.
     *
     * To find out what models are available, you can use the `lms ls` command, or programmatically
     * use the `client.system.listDownloadedModels` method.
     *
     * Here are some examples:
     *
     * Loading Llama 3.2:
     *
     * ```typescript
     * const model = await client.llm.load("llama-3.2-3b-instruct");
     * ```
     *
     * Once loaded, see {@link LLMDynamicHandle} or {@link EmbeddingDynamicHandle} for how to use the
     * model for inferencing or other things you can do with the model.
     *
     * @param modelKey - The path of the model to load.
     * @param opts - Options for loading the model.
     * @returns A promise that resolves to the model that can be used for inferencing
     */
    async load(modelKey, opts = {}) {
        const stack = getCurrentStack(1);
        [modelKey, opts] = this.validator.validateMethodParamsOrThrow(`client.${this.namespace}`, "load", ["modelKey", "opts"], [reasonableKeyStringSchema, this.getLoadModelOptsSchema()], [modelKey, opts], stack);
        const { identifier, signal, verbose = "info", config, onProgress } = opts;
        let lastVerboseCallTime = 0;
        const { promise, resolve, reject } = makePromise();
        const verboseLevel = typeof verbose === "boolean" ? "info" : verbose;
        const startTime = Date.now();
        if (verbose) {
            this.logger.logAtLevel(verboseLevel, text `
          Verbose logging is enabled. To hide progress logs, set the "verbose" option to false in
          client.llm.load.
        `);
        }
        let fullPath = modelKey;
        const channel = this.port.createChannel("loadModel", {
            modelKey,
            identifier,
            ttlMs: opts.ttl === undefined ? undefined : opts.ttl * 1000,
            loadConfigStack: singleLayerKVConfigStackOf("apiOverride", this.loadConfigToKVConfig(config ?? this.defaultLoadConfig)),
        }, message => {
            switch (message.type) {
                case "resolved": {
                    fullPath = message.info.modelKey;
                    if (message.ambiguous !== undefined) {
                        this.logger.warn(text `
                Multiple models found for key ${modelKey}:

                ${message.ambiguous.map(x => ` - ${x}`).join("\n")}

                Using the first one.
              `);
                    }
                    if (verbose) {
                        this.logger.logAtLevel(verboseLevel, text `
                  Start loading model ${fullPath}...
                `);
                    }
                    break;
                }
                case "success": {
                    if (verbose) {
                        this.logger.logAtLevel(verboseLevel, text `
                  Successfully loaded model ${fullPath} in ${Date.now() - startTime}ms
                `);
                    }
                    resolve(this.createDomainSpecificModel(this.port, message.info, this.validator, this.logger));
                    break;
                }
                case "progress": {
                    const { progress } = message;
                    if (onProgress !== undefined) {
                        safeCallCallback(this.logger, "onProgress", onProgress, [progress]);
                    }
                    else if (verbose) {
                        const now = Date.now();
                        if (now - lastVerboseCallTime > 500 || progress === 1) {
                            const progressText = (progress * 100).toFixed(1);
                            this.logger.logAtLevel(verboseLevel, `Loading the model, progress: ${progressText}%`);
                            lastVerboseCallTime = now;
                        }
                    }
                }
            }
        }, { stack });
        channel.onError.subscribeOnce(reject);
        if (signal !== undefined) {
            if (signal.aborted) {
                // If the signal is already aborted, we should reject immediately.
                channel.send({ type: "cancel" });
                reject(signal.reason);
            }
            else {
                signal.addEventListener("abort", () => {
                    channel.send({ type: "cancel" });
                    reject(signal.reason);
                }, { once: true });
            }
        }
        return await promise;
    }
    /**
     * Unload a model. Once a model is unloaded, it can no longer be used. If you wish to use the
     * model afterwards, you will need to load it with {@link LLMNamespace#loadModel} again.
     *
     * @param identifier - The identifier of the model to unload.
     */
    unload(identifier) {
        const stack = getCurrentStack(1);
        this.validator.validateMethodParamOrThrow(`client.${this.namespace}`, "unload", "identifier", reasonableKeyStringSchema, identifier, stack);
        return this.port.callRpc("unloadModel", { identifier }, { stack });
    }
    /**
     * List all the currently loaded models.
     */
    async listLoaded() {
        const stack = getCurrentStack(1);
        const infos = await this.port.callRpc("listLoaded", undefined, { stack });
        return infos.map(info => this.createDomainSpecificModel(this.port, info, this.validator, this.logger));
    }
    /**
     * Get any loaded model of this domain.
     */
    async getAny(stack) {
        const info = await this.port.callRpc("getModelInfo", { specifier: { type: "query", query: {} }, throwIfNotFound: true }, { stack });
        if (info === undefined) {
            throw new Error("Backend should have thrown.");
        }
        return this.createDomainSpecificModel(this.port, info, this.validator, new SimpleLogger("LLM", this.logger));
    }
    createDynamicHandle(param) {
        const stack = getCurrentStack(1);
        this.validator.validateMethodParamOrThrow(`client.${this.namespace}`, "createDynamicHandle", "param", zod.z.union([reasonableKeyStringSchema, modelQuerySchema]), param, stack);
        let query;
        if (typeof param === "string") {
            query = {
                identifier: param,
            };
        }
        else {
            query = param;
        }
        if (query.path?.includes("\\")) {
            throw makePrettyError(text `
          Model path should not contain backslashes, even if you are on Windows. Use forward
          slashes instead.
        `, stack);
        }
        return this.createDomainDynamicHandle(this.port, {
            type: "query",
            query,
        }, this.validator, new SimpleLogger("DynamicHandle", this.logger));
    }
    /**
     * Create a dynamic handle from the internal instance reference.
     *
     * @alpha
     */
    createDynamicHandleFromInstanceReference(instanceReference) {
        const stack = getCurrentStack(1);
        this.validator.validateMethodParamOrThrow(`client.${this.namespace}`, "createDynamicHandleFromInstanceReference", "instanceReference", zod.z.string(), instanceReference, stack);
        return this.createDomainDynamicHandle(this.port, {
            type: "instanceReference",
            instanceReference,
        }, this.validator, new SimpleLogger("DynamicHandle", this.logger));
    }
    async model(modelKey, opts = {}) {
        const stack = getCurrentStack(1);
        if (modelKey === undefined) {
            // We want to get any loaded model.
            return await this.getAny(stack);
        }
        [modelKey, opts] = this.validator.validateMethodParamsOrThrow(`client.${this.namespace}`, "model", ["modelKey", "opts"], [reasonableKeyStringSchema, this.getLoadModelOptsSchema()], [modelKey, opts], stack);
        const { identifier, signal, verbose = "info", config, onProgress } = opts;
        if (identifier !== undefined) {
            throw new Error("The identifier option is not allowed when using `.model`.");
        }
        let lastVerboseCallTime = 0;
        const { promise, resolve, reject } = makePromise();
        const verboseLevel = typeof verbose === "boolean" ? "info" : verbose;
        const startTime = Date.now();
        const channel = this.port.createChannel("getOrLoad", {
            identifier: modelKey,
            loadTtlMs: opts.ttl === undefined ? undefined : opts.ttl * 1000,
            loadConfigStack: singleLayerKVConfigStackOf("apiOverride", this.loadConfigToKVConfig(config ?? this.defaultLoadConfig)),
        }, message => {
            switch (message.type) {
                case "alreadyLoaded": {
                    return resolve(this.createDomainSpecificModel(this.port, message.info, this.validator, this.logger));
                }
                case "unloadingOtherJITModel": {
                    if (verbose) {
                        this.logger.logAtLevel(verboseLevel, text `
                  Unloading other JIT model ${message.info.modelKey}. (You can disable this behavior
                  by going to LM Studio -> Settings -> Developer -> Turn OFF JIT models auto-evict)
                `);
                    }
                    break;
                }
                case "startLoading": {
                    if (verbose) {
                        this.logger.logAtLevel(verboseLevel, text `
                  Verbose logging is enabled. To hide progress logs, set the "verbose" option to
                  false in .model().
                `);
                        this.logger.logAtLevel(verboseLevel, text `
                  Model ${modelKey} is not loaded. Start loading...
                `);
                    }
                    break;
                }
                case "loadProgress": {
                    const { progress } = message;
                    if (onProgress !== undefined) {
                        safeCallCallback(this.logger, "onProgress", onProgress, [progress]);
                    }
                    else if (verbose) {
                        const now = Date.now();
                        if (now - lastVerboseCallTime > 500 || progress === 1) {
                            const progressText = (progress * 100).toFixed(1);
                            this.logger.logAtLevel(verboseLevel, `Loading the model, progress: ${progressText}%`);
                            lastVerboseCallTime = now;
                        }
                    }
                    break;
                }
                case "loadSuccess": {
                    if (verbose) {
                        this.logger.logAtLevel(verboseLevel, text `
                  Successfully loaded model ${message.info.modelKey} in ${Date.now() - startTime}ms
                `);
                    }
                    resolve(this.createDomainSpecificModel(this.port, message.info, this.validator, this.logger));
                }
            }
        }, { stack });
        channel.onError.subscribeOnce(reject);
        signal?.addEventListener("abort", () => {
            channel.send({ type: "cancel" });
            reject(signal.reason);
        });
        return await promise;
    }
}

/**
 * Translate a number to a checkbox numeric value.
 *
 * @param value - The value to translate.
 * @param uncheckedValue - The value to use when the checkbox is unchecked.
 * @param valueWhenUnchecked - The value to use when the checkbox is unchecked.
 */
function numberToCheckboxNumeric(value, uncheckedValue, valueWhenUnchecked) {
    if (value === undefined) {
        return undefined;
    }
    if (value === uncheckedValue) {
        return { checked: false, value: valueWhenUnchecked };
    }
    return { checked: true, value };
}

/**
 * This represents a set of requirements for a model. It is not tied to a specific model, but rather
 * to a set of requirements that a model must satisfy.
 *
 * For example, if you got the model via `client.llm.get("my-identifier")`, you will get a
 * `LLMModel` for the model with the identifier `my-identifier`. If the model is unloaded, and
 * another model is loaded with the same identifier, using the same `LLMModel` will use the new
 * model.
 *
 * @public
 */
class DynamicHandle {
    /**
     * Don't construct this on your own. Use {@link LLMNamespace#get} or {@link LLMNamespace#load}
     * instead.
     *
     * @internal
     */
    constructor(
    /** @internal */
    port, 
    /** @internal */
    specifier) {
        this.port = port;
        this.specifier = specifier;
    }
    /**
     * Gets the information of the model that is currently associated with this `DynamicHandle`. If no
     * model is currently associated, this will return `undefined`.
     *
     * Note: As models are loaded/unloaded, the model associated with this `LLMModel` may change at
     * any moment.
     */
    async getModelInfo() {
        const info = await this.port.callRpc("getModelInfo", { specifier: this.specifier, throwIfNotFound: false }, { stack: getCurrentStack(1) });
        if (info === undefined) {
            return undefined;
        }
        return info;
    }
    async getLoadConfig(stack) {
        const loadConfig = await this.port.callRpc("getLoadConfig", { specifier: this.specifier }, { stack });
        return loadConfig;
    }
}

/**
 * This represents a set of requirements for a model. It is not tied to a specific model, but rather
 * to a set of requirements that a model must satisfy.
 *
 * For example, if you got the model via `client.embedding.get("my-identifier")`, you will get a
 * `EmbeddingModel` for the model with the identifier `my-identifier`. If the model is unloaded, and
 * another model is loaded with the same identifier, using the same `EmbeddingModel` will use the
 * new model.
 *
 * @public
 */
class EmbeddingDynamicHandle extends DynamicHandle {
    /**
     * Don't construct this on your own. Use {@link EmbeddingNamespace#get} or
     * {@link EmbeddingNamespace#load}
     * instead.
     *
     * @internal
     */
    constructor(
    /** @internal */
    port, 
    /** @internal */
    specifier, 
    /** @internal */
    validator, 
    /** @internal */
    logger = new SimpleLogger(`EmbeddingModel`)) {
        super(port, specifier);
        this.validator = validator;
        this.logger = logger;
    }
    async embed(inputString) {
        const stack = getCurrentStack(1);
        inputString = this.validator.validateMethodParamOrThrow("client.embedding", "embed", "inputString", zod.z.string().or(zod.z.array(zod.z.string())), inputString, stack);
        if (Array.isArray(inputString)) {
            return await Promise.all(inputString.map(s => this.port.callRpc("embedString", { inputString: s, modelSpecifier: this.specifier }, { stack })));
        }
        else {
            return await this.port.callRpc("embedString", { inputString, modelSpecifier: this.specifier }, { stack });
        }
    }
    async getContextLength() {
        const stack = getCurrentStack(1);
        const loadConfig = await this.getLoadConfig(stack);
        return embeddingSharedLoadConfigSchematics.access(loadConfig, "contextLength");
    }
    async getEvalBatchSize() {
        const stack = getCurrentStack(1);
        const loadConfig = await this.getLoadConfig(stack);
        return globalConfigSchematics.access(loadConfig, "embedding.load.llama.evalBatchSize");
    }
    async tokenize(inputString) {
        const stack = getCurrentStack(1);
        inputString = this.validator.validateMethodParamOrThrow("model", "tokenize", "inputString", zod.z.string().or(zod.z.array(zod.z.string())), inputString, stack);
        if (Array.isArray(inputString)) {
            return (await Promise.all(inputString.map(s => this.port.callRpc("tokenize", { specifier: this.specifier, inputString: s }, { stack })))).map(r => r.tokens);
        }
        else {
            return (await this.port.callRpc("tokenize", {
                specifier: this.specifier,
                inputString,
            }, { stack })).tokens;
        }
    }
    async countTokens(inputString) {
        const stack = getCurrentStack(1);
        inputString = this.validator.validateMethodParamOrThrow("model", "countTokens", "inputString", zod.z.string(), inputString, stack);
        return (await this.port.callRpc("countTokens", {
            specifier: this.specifier,
            inputString,
        }, { stack })).tokenCount;
    }
}

/**
 * Represents a specific loaded Embedding. Most Embedding related operations are inherited from
 * {@link EmbeddingDynamicHandle}.
 *
 * @public
 */
class EmbeddingModel extends EmbeddingDynamicHandle {
    /** @internal */
    constructor(embeddingPort, info, validator, logger = new SimpleLogger(`EmbeddingModel`)) {
        const specifier = {
            type: "instanceReference",
            instanceReference: info.instanceReference,
        };
        super(embeddingPort, specifier, validator, logger);
        this.identifier = info.identifier;
        this.path = info.path;
        this.modelKey = info.modelKey;
        this.format = info.format;
        this.displayName = info.displayName;
        this.sizeBytes = info.sizeBytes;
    }
    async unload() {
        const stack = getCurrentStack(1);
        await this.port.callRpc("unloadModel", { identifier: this.identifier }, { stack });
    }
    async getModelInfo() {
        const info = await super.getModelInfo();
        if (info === undefined) {
            const stack = getCurrentStack(1);
            throw makePrettyError("This model has already been unloaded", stack);
        }
        return info;
    }
}

/** @public */
class EmbeddingNamespace extends ModelNamespace {
    constructor() {
        super(...arguments);
        /** @internal */
        this.namespace = "embedding";
        /** @internal */
        this.defaultLoadConfig = {};
        /** @internal */
        this.loadModelConfigSchema = embeddingLoadModelConfigSchema;
    }
    /** @internal */
    loadConfigToKVConfig(config) {
        return embeddingLlamaLoadConfigSchematics.buildPartialConfig({
            "llama.acceleration.offloadRatio": config.gpu?.ratio,
            "load.gpuSplitConfig": convertGPUSettingToGPUSplitConfig(config.gpu),
            "contextLength": config.contextLength,
            "llama.ropeFrequencyBase": numberToCheckboxNumeric(config.ropeFrequencyBase, 0, 0),
            "llama.ropeFrequencyScale": numberToCheckboxNumeric(config.ropeFrequencyScale, 0, 0),
            "llama.keepModelInMemory": config.keepModelInMemory,
            "llama.tryMmap": config.tryMmap,
        });
    }
    /** @internal */
    createDomainSpecificModel(port, info, validator, logger) {
        return new EmbeddingModel(port, info, validator, logger);
    }
    /** @internal */
    createDomainDynamicHandle(port, specifier, validator, logger) {
        return new EmbeddingDynamicHandle(port, specifier, validator, logger);
    }
}

const parseDocumentOptsSchema = documentParsingOptsSchema.extend({
    onProgress: zod.z.function().optional(),
    signal: zod.z.instanceof(AbortSignal).optional(),
});

const retrievalCallbacksSchema = zod.z.object({
    onFileProcessList: zod.z.function().optional(),
    onFileProcessingStart: zod.z.function().optional(),
    onFileProcessingEnd: zod.z.function().optional(),
    onFileProcessingStepStart: zod.z.function().optional(),
    onFileProcessingStepProgress: zod.z.function().optional(),
    onFileProcessingStepEnd: zod.z.function().optional(),
    onSearchingStart: zod.z.function().optional(),
    onSearchingEnd: zod.z.function().optional(),
    verbose: zod.z.union([zod.z.boolean(), zod.z.string()]).optional(),
});
const retrievalOptsSchema = zod.z.object({
    chunkingMethod: retrievalChunkingMethodSchema.optional(),
    limit: zod.z.number().int().optional(),
    embeddingModel: zod.z.instanceof(EmbeddingDynamicHandle).optional(),
    databasePath: zod.z.string().optional(),
    signal: zod.z.instanceof(AbortSignal).optional(),
    ...retrievalCallbacksSchema.shape,
});

function getProcessingStepName(processingStep) {
    switch (processingStep) {
        case "loading":
            return "Loading";
        case "chunking":
            return "Chunking";
        case "embedding":
            return "Embedding";
        default: {
            const exhaustiveCheck = processingStep;
            throw new Error(`Unexpected processing step: ${exhaustiveCheck}`);
        }
    }
}
/**
 * @public
 *
 * The namespace for file-related operations.
 */
class FilesNamespace {
    /** @internal */
    constructor(
    /** @internal */
    filesPort, validator, parentLogger) {
        this.filesPort = filesPort;
        this.validator = validator;
        this.logger = new SimpleLogger("File", parentLogger);
    }
    /**
     * Gets the absolute path to a local file.
     *
     * @internal
     */
    async getLocalFileAbsolutePath(fileName, stack) {
        return await this.filesPort.callRpc("getLocalFileAbsolutePath", { fileName }, { stack });
    }
    /**
     * Creates a file handle from a chat message part file data. Used internally.
     *
     * @internal
     */
    createFileHandleFromChatMessagePartFileData(data) {
        return new FileHandle(this, data.identifier, data.fileType, data.sizeBytes, data.name);
    }
    /**
     * Adds a temporary image to LM Studio, and returns a FileHandle that can be used to reference
     * this image. This image will be deleted when the client disconnects.
     *
     * This method can only be used in environments that have file system access (such as Node.js).
     */
    async prepareImage(path) {
        const result = await lmsIsomorphic.readFileAsBase64(path);
        if (result.success === false) {
            throw new Error(text `
        Your current JavaScript environment does not support reading files. If you can read the file
        using other methods, please use "prepareImageBase64".
      `);
        }
        const fileName = path.split(/[\\/]/).at(-1);
        const { identifier, fileType, sizeBytes } = await this.filesPort.callRpc("uploadFileBase64", {
            name: fileName,
            contentBase64: result.base64,
        });
        return new FileHandle(this, identifier, fileType, sizeBytes, fileName);
    }
    /**
     * Adds a temporary image to LM Studio. The content of the file is specified using base64. If you
     * are using Node.js and have a file laying around, consider using `prepareImage` instead.
     */
    async prepareImageBase64(fileName, contentBase64) {
        const { identifier, fileType, sizeBytes } = await this.filesPort.callRpc("uploadFileBase64", {
            name: fileName,
            contentBase64,
        });
        return new FileHandle(this, identifier, fileType, sizeBytes, fileName);
    }
    /**
     * Adds a temporary file to LM Studio, and returns a FileHandle that can be used to reference this
     * file. This file will be deleted when the client disconnects.
     *
     * This method can only be used in environments that have file system access (such as Node.js).
     *
     * @deprecated [DEP-RETRIEVAL] Retrieval API is still in active development. Stay tuned for
     * updates.
     */
    async prepareFile(path) {
        // Currently, exactly the same as prepareImage.
        const result = await lmsIsomorphic.readFileAsBase64(path);
        if (result.success === false) {
            throw new Error(text `
        Your current JavaScript environment does not support reading files. If you can read the file
        using other methods, please use "prepareFileBase64".
      `);
        }
        const fileName = path.split(/[\\/]/).at(-1);
        const { identifier, fileType, sizeBytes } = await this.filesPort.callRpc("uploadFileBase64", {
            name: fileName,
            contentBase64: result.base64,
        });
        return new FileHandle(this, identifier, fileType, sizeBytes, fileName);
    }
    /**
     * Adds a temporary file to LM Studio. The content of the file is specified using base64. If you
     * are using Node.js and have a file laying around, consider using `prepareFile` instead.
     *
     * @deprecated [DEP-RETRIEVAL] Retrieval API is still in active development. Stay tuned for
     * updates.   */
    async prepareFileBase64(fileName, contentBase64) {
        // Currently, exactly the same as prepareImageBase64.
        const { identifier, fileType, sizeBytes } = await this.filesPort.callRpc("uploadFileBase64", {
            name: fileName,
            contentBase64,
        });
        return new FileHandle(this, identifier, fileType, sizeBytes, fileName);
    }
    /**
     * @deprecated [DEP-RETRIEVAL] Retrieval API is still in active development. Stay tuned for
     * updates.   */
    async retrieve(query, files, opts = {}) {
        const logger = this.logger;
        const stack = getCurrentStack(1);
        this.validator.validateMethodParamsOrThrow("client.retrieval", "retrieve", ["query", "filePaths", "opts"], [zod.z.string(), zod.z.array(zod.z.instanceof(FileHandle)), retrievalOptsSchema], [query, files, opts], stack);
        const { verbose = "info" } = opts;
        const verboseLevel = typeof verbose === "boolean" ? "info" : verbose;
        const shouldLog = verbose &&
            opts.onFileProcessList === undefined &&
            opts.onFileProcessingStart === undefined &&
            opts.onFileProcessingEnd === undefined &&
            opts.onFileProcessingStepStart === undefined &&
            opts.onFileProcessingStepProgress === undefined &&
            opts.onFileProcessingStepEnd === undefined &&
            opts.onSearchingStart === undefined &&
            opts.onSearchingEnd === undefined;
        if (opts.embeddingModel === undefined) {
            throw new Error("Embedding model currently is required.");
        }
        const resolveFileIndex = (index) => {
            const file = files[index];
            if (file === undefined) {
                throw new Error(`File not found: ${index}`);
            }
            return file;
        };
        const resolveFileIndices = (indices) => {
            return indices.map(resolveFileIndex);
        };
        const kvConfig = retrievalSchematics.buildPartialConfig({
            chunkingMethod: opts.chunkingMethod,
            databaseFile: opts.databasePath,
            embeddingModel: (await opts.embeddingModel.getModelInfo())?.identifier,
            limit: opts.limit,
        });
        let filesToProcess;
        const filesProcessingStartTimes = [];
        let searchingStartTime = 0;
        let lastVerboseCallTime = 0;
        let lastVerboseLine = "";
        return await new Promise((resolve, reject) => {
            const channel = this.filesPort.createChannel("retrieve", { query, fileIdentifiers: files.map(file => file.identifier), config: kvConfig }, message => {
                switch (message.type) {
                    case "onFileProcessList":
                        filesToProcess = resolveFileIndices(message.indices);
                        safeCallCallback(logger, "onFileProcessList", opts.onFileProcessList, [
                            filesToProcess,
                        ]);
                        if (shouldLog) {
                            logger.logAtLevel(verboseLevel, text `
                    Found ${filesToProcess.length} files need processing:
                    ${filesToProcess.map(file => file.name).join(", ")}
                  `);
                        }
                        break;
                    case "onFileProcessingStart": {
                        if (filesToProcess === null) {
                            throw new Error("onFileProcessList must be called before onFileProcessingStart");
                        }
                        const file = resolveFileIndex(message.index);
                        safeCallCallback(logger, "onFileProcessingStart", opts.onFileProcessingStart, [
                            file,
                            filesToProcess.indexOf(file),
                            filesToProcess,
                        ]);
                        if (shouldLog) {
                            filesProcessingStartTimes[message.index] = Date.now();
                            logger.logAtLevel(verboseLevel, text `
                    Start processing file: ${file.name}
                    (${message.index + 1}/${filesToProcess.length})
                  `);
                        }
                        break;
                    }
                    case "onFileProcessingEnd": {
                        if (filesToProcess === null) {
                            throw new Error("onFileProcessList must be called before onFileProcessingEnd");
                        }
                        const file = resolveFileIndex(message.index);
                        safeCallCallback(logger, "onFileProcessingEnd", opts.onFileProcessingEnd, [
                            file,
                            filesToProcess.indexOf(file),
                            filesToProcess,
                        ]);
                        if (shouldLog) {
                            logger.logAtLevel(verboseLevel, text `
                    File processed: ${file.name}.
                    Time took: ${Date.now() - filesProcessingStartTimes[message.index]}ms
                  `);
                        }
                        break;
                    }
                    case "onFileProcessingStepStart":
                        safeCallCallback(logger, "onFileProcessingStepStart", opts.onFileProcessingStepStart, [resolveFileIndex(message.index), message.step]);
                        break;
                    case "onFileProcessingStepProgress": {
                        safeCallCallback(logger, "onFileProcessingStepProgress", opts.onFileProcessingStepProgress, [resolveFileIndex(message.index), message.step, message.progress]);
                        const now = Date.now();
                        if (shouldLog && (now - lastVerboseCallTime > 500 || message.progress === 1)) {
                            lastVerboseCallTime = now;
                            const line = text `
                  > ${getProcessingStepName(message.step)}: ${Math.round(message.progress * 100)}%
                `;
                            if (lastVerboseLine !== line) {
                                lastVerboseLine = line;
                                logger.logAtLevel(verboseLevel, line);
                            }
                        }
                        break;
                    }
                    case "onFileProcessingStepEnd":
                        safeCallCallback(logger, "onFileProcessingStepEnd", opts.onFileProcessingStepEnd, [
                            resolveFileIndex(message.index),
                            message.step,
                        ]);
                        break;
                    case "onSearchingStart":
                        safeCallCallback(logger, "onSearchingStart", opts.onSearchingStart, []);
                        if (shouldLog) {
                            searchingStartTime = Date.now();
                            logger.logAtLevel(verboseLevel, "Start searching in the vector database...");
                        }
                        break;
                    case "onSearchingEnd":
                        safeCallCallback(logger, "onSearchingEnd", opts.onSearchingEnd, []);
                        if (shouldLog) {
                            logger.logAtLevel(verboseLevel, text `
                    Finished searching in the vector database.
                    Time took: ${Date.now() - searchingStartTime}ms
                  `);
                        }
                        break;
                    case "result": {
                        resolve({
                            entries: message.result.entries.map(entry => ({
                                content: entry.content,
                                score: entry.score,
                                source: files[entry.sourceIndex],
                            })),
                        });
                        break;
                    }
                }
            });
            if (opts.signal !== undefined) {
                if (opts.signal.aborted) {
                    reject(opts.signal.reason);
                    channel.send({ type: "stop" });
                }
                else {
                    opts.signal?.addEventListener("abort", () => {
                        reject(opts.signal.reason);
                        channel.send({ type: "stop" });
                    });
                }
            }
            channel.onError.subscribeOnce(reject);
        });
    }
    /**
     * Parse a document
     *
     * @deprecated [DEP-DOC-PARSE] Document parsing API is still in active development. Stay tuned for
     * updates.
     */
    async parseDocument(fileHandle, opts = {}) {
        const stack = getCurrentStack(1);
        this.validator.validateMethodParamsOrThrow("client.files", "parseDocument", ["fileHandle", "opts"], [zod.z.instanceof(FileHandle), parseDocumentOptsSchema], [fileHandle, opts], stack);
        const { onParserLoaded, onProgress, signal, ...config } = opts;
        const { promise, resolve, reject } = makePromise();
        opts.signal?.throwIfAborted();
        let finished = false;
        const channel = this.filesPort.createChannel("parseDocument", { fileIdentifier: fileHandle.identifier, parseOpts: config }, message => {
            const messageType = message.type;
            switch (messageType) {
                case "progress": {
                    safeCallCallback(this.logger, "onProgress", onProgress, [message.progress]);
                    break;
                }
                case "parserLoaded": {
                    safeCallCallback(this.logger, "onParserLoaded", onParserLoaded, [message.parser]);
                    break;
                }
                case "result": {
                    resolve({
                        content: message.content,
                        parser: message.parser,
                    });
                    finished = true;
                    break;
                }
            }
        }, { stack });
        signal?.addEventListener("abort", () => {
            if (finished) {
                return;
            }
            reject(signal.reason);
            channel.send({ type: "cancel" });
        });
        channel.onError.subscribeOnce(reject);
        channel.onClose.subscribeOnce(() => {
            if (!finished) {
                reject(new Error("Channel closed before receiving a result."));
            }
        });
        return await promise;
    }
    /**
     * Get the parsing method for a document.
     *
     * @deprecated [DEP-DOC-PARSE] Document parsing API is still in active development. Stay tuned for
     * updates.
     */
    async getDocumentParsingLibrary(fileHandle) {
        const stack = getCurrentStack(1);
        return await this.filesPort.callRpc("getDocumentParsingLibrary", { fileIdentifier: fileHandle.identifier }, { stack });
    }
}

function deserializeOtherError(serialized, stack) {
    let content = chalk.redBright(` ${serialized.title} `);
    if (serialized.suggestion !== undefined) {
        content +=
            "\n\n\n " +
                chalk.bgWhite.black("  (!) SUGGESTION  ") +
                "\n\n" +
                chalk.white(serialized.suggestion);
    }
    if (serialized.cause !== undefined) {
        content +=
            "\n\n\n " + chalk.bgWhite.black("  (X) CAUSE  ") + "\n\n" + chalk.gray(serialized.cause);
    }
    return makePrettyError(content, stack);
}
const errorDeserializersMap = new Map();
function registerErrorDeserializer(code, deserializer) {
    errorDeserializersMap.set(code, deserializer);
}
function formatAvailableLLMs(availablePathsSample, totalModels) {
    if (availablePathsSample.length === 0) {
        return chalk.gray("    You don't have any LLMs downloaded.");
    }
    let text = availablePathsSample.map(path => chalk.cyanBright(" • " + path)).join("\n");
    if (availablePathsSample.length < totalModels) {
        text += chalk.gray(`\n     ... (and ${totalModels - availablePathsSample.length} more)`);
    }
    return text;
}
registerErrorDeserializer("generic.pathNotFound", ({ availablePathsSample, path, totalModels }, stack) => {
    return makeTitledPrettyError(`Cannot find a model with path "${chalk.yellowBright(path)}"`, text `
        Here are your available models:

        ${formatAvailableLLMs(availablePathsSample, totalModels)}

        Run

            ${chalk.yellowBright("lms ls")}

        to see a full list of loadable models
      `, stack);
});
function formatLoadedModels(loadedModelsSample, totalLoadedModels) {
    if (loadedModelsSample.length === 0) {
        return chalk.gray("    You don't have any models loaded.");
    }
    let text = loadedModelsSample.map(path => chalk.cyanBright(" • " + path)).join("\n");
    if (loadedModelsSample.length < totalLoadedModels) {
        text += chalk.gray(`\n     ... (and ${totalLoadedModels - loadedModelsSample.length} more)`);
    }
    return text;
}
registerErrorDeserializer("generic.identifierNotFound", ({ loadedModelsSample, identifier, totalLoadedModels }, stack) => {
    return makeTitledPrettyError(`Cannot find a model with identifier "${chalk.yellowBright(identifier)}"`, text `
        Here are your loaded models:

        ${formatLoadedModels(loadedModelsSample, totalLoadedModels)}

        Run

            ${chalk.yellowBright("lms ps")}

        to see a full list of loaded models
      `, stack);
});
registerErrorDeserializer("generic.specificModelUnloaded", (_, stack) => {
    return makePrettyError(chalk.bgRed.white(text `
      This model has already been unloaded.
    `), stack);
});
function getModelDomainTypeDisplayNameSingular(domain) {
    switch (domain) {
        case "llm":
            return "an LLM";
        case "embedding":
            return "an embedding model";
        case "imageGen":
            return "an image generation model";
        case "transcription":
            return "a transcription model";
        case "tts":
            return "a text-to-speech model";
        default: {
            const exhaustiveCheck = domain;
            console.error(`Unexpected domain type: ${exhaustiveCheck}`);
            return "Unknown Model Domain";
        }
    }
}
function formatQuery(query) {
    const requirements = [];
    if (query.domain !== undefined) {
        requirements.push(text `
      The model must be ${chalk.yellowBright(getModelDomainTypeDisplayNameSingular(query.domain))}
    `);
    }
    if (query.identifier !== undefined) {
        requirements.push(`The identifier must be exactly "${chalk.yellowBright(query.identifier)}"`);
    }
    if (query.path !== undefined) {
        requirements.push(`The path must match "${chalk.yellowBright(query.path)}"`);
    }
    if (requirements.length === 0) {
        return chalk.gray(" • Any Model");
    }
    return requirements.map(req => chalk.white(" • " + req)).join("\n");
}
registerErrorDeserializer("generic.noModelMatchingQuery", ({ loadedModelsSample, totalLoadedModels, query }, stack) => {
    return makePrettyError(text `
        ${chalk.bgRed.white(" No loaded model satisfies all requirements specified in the query. ")}

        Loaded Models:

        ${formatLoadedModels(loadedModelsSample, totalLoadedModels)}

        Your query:

        ${formatQuery(query)}

        Run

            ${chalk.yellowBright("lms ps")}

        to see a full list of loaded models with details
      `, stack);
});
registerErrorDeserializer("generic.domainMismatch", ({ actualDomain, expectedDomain, path }, stack) => {
    return makePrettyError(text `
        ${chalk.bgRed.white(" Model has wrong domain. ")}

        Expecting ${chalk.greenBright(path)} to be ${chalk.yellowBright(getModelDomainTypeDisplayNameSingular(expectedDomain))}, but it is actually ${chalk.yellowBright(getModelDomainTypeDisplayNameSingular(actualDomain))}.
      `, stack);
});
function formatAvailablePresets(presets, totalAvailablePresets) {
    if (presets.length === 0) {
        return chalk.gray("    You don't have any presets available.");
    }
    let text = presets
        .map(({ identifier, name }) => chalk.cyanBright(` • ${name} (${chalk.cyan(identifier)})`))
        .join("\n");
    if (presets.length < totalAvailablePresets) {
        text += chalk.gray(`\n     ... (and ${totalAvailablePresets - presets.length} more)`);
    }
    return text;
}
registerErrorDeserializer("generic.presetNotFound", ({ specifiedFuzzyPresetIdentifier, availablePresetsSample, totalAvailablePresets }) => {
    return makeTitledPrettyError(`Cannot find a preset with identifier "${chalk.yellowBright(specifiedFuzzyPresetIdentifier)}"`, text `
        Here are your available presets:

        ${formatAvailablePresets(availablePresetsSample, totalAvailablePresets)}

        Note: To specify a preset in the SDK, you need to use its identifier (in parentheses). You
        can get a preset's identifier by right-clicking on it and then select "Copy Preset
        Identifier".
      `);
});
function friendlyErrorDeserializer(serialized, _directCause, stack) {
    if (serialized.displayData === undefined) {
        return deserializeOtherError(serialized, stack);
    }
    let error;
    const specificDeserializer = errorDeserializersMap.get(serialized.displayData.code);
    if (specificDeserializer !== undefined) {
        error = specificDeserializer(serialized.displayData, stack);
        attachSerializedErrorData(error, serialized);
        return error;
    }
    else {
        return deserializeOtherError(serialized, stack);
    }
}

function cacheQuantizationTypeToCheckbox({ value, falseDefault, }) {
    return value === undefined
        ? undefined
        : value === false
            ? { checked: false, value: falseDefault }
            : { checked: true, value: value };
}

/**
 * Represents the result of running `llm.act`. Currently only contains minimum amount of
 * information.
 *
 * If you think more information/fields should be added, please open an issue or a PR on GitHub.
 *
 * @public
 */
class ActResult {
    constructor(
    /**
     * Number of rounds performed.
     *
     * For example, in the following scenario:
     *
     * - User asks the model to add 1234 and 5678.
     * - The model requests to use a calculator tool.
     * - The calculator tool outputs 6912.
     * - The calculator's output is then fed back to the model for a second round of prediction.
     * - The model sees the output and generates a paragraph explaining the result.
     *
     * There are 2 rounds. On the beginning of a round, the callback `onRoundStart` is triggered.
     * On the end of a round, the callback `onRoundEnd` is triggered.
     */
    rounds, 
    /**
     * Total time taken to run `.act` in seconds. measured from beginning of the `.act` invocation
     * to when the entire operation is finished.
     */
    totalExecutionTimeSeconds) {
        this.rounds = rounds;
        this.totalExecutionTimeSeconds = totalExecutionTimeSeconds;
    }
}

/**
 * Each call uses a globally unique call ID that starts somewhere before the half of the
 * `Number.MAX_SAFE_INTEGER`.
 */
const callIdGiver = new IdGiver(Math.floor(Math.random() * (Number.MAX_SAFE_INTEGER / 2 / 10000)) * 10000);
class NoQueueQueue {
    needsQueueing() {
        return false;
    }
    async runInQueue(fn, signal) {
        if (signal?.aborted) {
            throw new Error("Operation aborted");
        }
        return fn();
    }
}
class FIFOQueue {
    constructor() {
        this.queue = [];
        this.executing = false;
        this.poisoned = false;
        this.poisonError = null;
    }
    needsQueueing() {
        return this.executing || this.queue.length > 0;
    }
    async runInQueue(fn, signal) {
        // Check if the operation is already aborted
        if (signal?.aborted) {
            throw new Error("Operation aborted");
        }
        // If the queue is poisoned, fail immediately with the saved error
        if (this.poisoned) {
            throw this.poisonError ?? new Error("Queue has been poisoned by a previous error");
        }
        if (!this.needsQueueing()) {
            // If nothing is in the queue, execute immediately
            this.executing = true;
            try {
                // Check for abort before execution
                if (signal?.aborted) {
                    throw new Error("Operation aborted");
                }
                return await fn();
            }
            catch (error) {
                // Poison the queue
                this.poisoned = true;
                this.poisonError = error;
                // Clear the queue since nothing will run after this
                this.clearQueue(error);
                throw error;
            }
            finally {
                this.executing = false;
                this.processQueue();
            }
        }
        // Otherwise, add to queue and wait for execution
        return new Promise((resolve, reject) => {
            // Add abort listener if a signal was provided
            if (signal) {
                if (signal.aborted) {
                    return reject(new Error("Operation aborted"));
                }
                signal.addEventListener("abort", () => {
                    // Remove from queue if it hasn't started yet
                    const index = this.queue.findIndex(item => item.resolve === resolve && item.reject === reject);
                    if (index !== -1) {
                        this.queue.splice(index, 1);
                        reject(new Error("Operation aborted"));
                    }
                }, { once: true });
            }
            this.queue.push({
                fn: async () => {
                    try {
                        // Check for abort before execution
                        if (signal?.aborted) {
                            throw new Error("Operation aborted");
                        }
                        const result = await fn();
                        resolve(result);
                        return result;
                    }
                    catch (error) {
                        reject(error);
                        throw error;
                    }
                },
                resolve,
                reject,
                signal,
            });
        });
    }
    async processQueue() {
        if (this.executing || this.queue.length === 0 || this.poisoned) {
            return;
        }
        const nextItem = this.queue.shift();
        if (!nextItem)
            return;
        // Skip if this task has been aborted
        if (nextItem.signal?.aborted) {
            nextItem.reject(new Error("Operation aborted"));
            this.processQueue();
            return;
        }
        this.executing = true;
        try {
            await nextItem.fn();
        }
        catch (error) {
            // Poison the queue
            this.poisoned = true;
            this.poisonError = error;
            // Clear the queue since nothing will run after this
            this.clearQueue(error);
        }
        finally {
            this.executing = false;
            // Only continue processing if not poisoned
            if (!this.poisoned) {
                this.processQueue();
            }
        }
    }
    clearQueue(error) {
        // Reject all pending promises in the queue
        for (const item of this.queue) {
            item.reject(error);
        }
        this.queue = [];
    }
}
/**
 * Controller object used to allow/modify/deny a tool call.
 */
class GuardToolCallController {
    /**
     * Don't construct this object yourself.
     */
    constructor(toolCallRequest, tool, resultContainer) {
        this.toolCallRequest = toolCallRequest;
        this.tool = tool;
        this.resultContainer = resultContainer;
        /**
         * Allows the tool call to proceed without any modifications.
         */
        this.allow = () => {
            this.assertNoResultYet("allow", getCurrentStack(1));
            this.resultContainer[0] = { type: "allow" };
        };
        /**
         * Allows the tool call to proceed, but overrides the parameters with the provided ones.
         */
        this.allowAndOverrideParameters = (newParameters) => {
            this.assertNoResultYet("allowAndOverrideParameters", getCurrentStack(1));
            this.resultContainer[0] = { type: "allowAndOverrideParameters", parameters: newParameters };
        };
        /**
         * Denys the tool call with a specified reason. This will not interrupt the `.act` call. Instead,
         * the reason you provide will be provided to the model as the tool call result.
         *
         * If `reason` is not provided, a generic default reason will be used.
         *
         * If you wish to immediately fail the `.act` call, you can throw an error instead.
         */
        this.deny = (reason) => {
            this.assertNoResultYet("deny", getCurrentStack(1));
            this.resultContainer[0] = { type: "deny", reason };
        };
    }
    assertNoResultYet(calledMethodName, stack) {
        if (this.resultContainer[0] === null) {
            return;
        }
        // Oh no, the result has already been set! Make an error message.
        throw makeTitledPrettyError(`Cannot call ${calledMethodName} after a result has been set`, text `
        This tool call guard has already set a result previously (${this.resultContainer[0].type}). 
        You cannot set a result more than once.
      `, stack);
    }
}
const llmActBaseOptsSchema = zod.z.object({
    onFirstToken: zod.z.function().optional(),
    onPredictionFragment: zod.z.function().optional(),
    onMessage: zod.z.function().optional(),
    onRoundStart: zod.z.function().optional(),
    onRoundEnd: zod.z.function().optional(),
    onPredictionCompleted: zod.z.function().optional(),
    onPromptProcessingProgress: zod.z.function().optional(),
    onToolCallRequestStart: zod.z.function().optional(),
    onToolCallRequestNameReceived: zod.z.function().optional(),
    onToolCallRequestArgumentFragmentGenerated: zod.z.function().optional(),
    onToolCallRequestEnd: zod.z.function().optional(),
    onToolCallRequestFinalized: zod.z.function().optional(),
    onToolCallRequestFailure: zod.z.function().optional(),
    onToolCallRequestDequeued: zod.z.function().optional(),
    guardToolCall: zod.z.function().optional(),
    handleInvalidToolRequest: zod.z.function().optional(),
    maxPredictionRounds: zod.z.number().int().min(1).optional(),
    signal: zod.z.instanceof(AbortSignal).optional(),
    allowParallelToolExecution: zod.z.boolean().optional(),
});
const defaultHandleInvalidToolRequest = (error, request) => {
    if (request) {
        return error.message;
    }
    throw error;
};
/**
 * The internal method for performing .act(). This is used by both `LLMDynamicHandle` and
 * `LLMGeneratorHandle`.
 *
 * @param TPredictionResult - The type of the prediction result.
 * @param TEndPacket - The type of the success packet that is returned. This type is received from
 * `handlePredictionEnd` and is passed to the `makePredictionResult` function to create the
 * `TPredictionResult`.
 * @param chat - The chat to use for the prediction.
 * @param tools - The tools to use for the prediction. This is an array of tools that the model can
 * use during the prediction.
 * @param baseOpts - The base options for the prediction. This includes callbacks and other
 * options that control the prediction process.
 * @param stack - The stack trace to use for the prediction. This is used for generating errors.
 * @param logger - The logger to use for the prediction. This is used for logging messages during
 * the prediction.
 * @param startTime - The start time of the prediction. This is used to calculate the duration of
 * the act.
 * @param predictImpl - The implementation of the prediction. This is a function that takes the
 * prediction arguments and performs the prediction. This is the main abstraction - `internalAct`
 * performs the prediction loop while this function handles the actual prediction itself.
 * @param makePredictionResult - A function that takes the end packet and the content of the
 * prediction and creates the `TPredictionResult`. This is used to create the prediction result
 * object for each round of the prediction.
 */
async function internalAct(chat, tools, baseOpts, stack, logger, startTime, predictImpl, makePredictionResult) {
    const abortController = new AbortController();
    const mutableChat = Chat.from(chat); // Make a copy
    let currentCallId = -1;
    /**
     * A flag that will be set if any unimplemented tool is called. In which case, the loop will
     * terminate after all the parallel tool calls are resolved.
     */
    let hasCalledUnimplementedTool = false;
    if (baseOpts.signal !== undefined) {
        if (baseOpts.signal.aborted) {
            // If the signal is already aborted, we should not continue.
            abortController.abort(baseOpts.signal.reason);
        }
        else {
            baseOpts.signal.addEventListener("abort", () => {
                abortController.abort(baseOpts.signal?.reason);
            }, { once: true });
        }
    }
    let shouldContinue = false;
    let predictionsPerformed = 0;
    const toolsMap = new Map();
    for (const tool of tools) {
        if (toolsMap.has(tool.name)) {
            logger.warnText `
        Duplicate tool (${tool.name}) found in the tools array. The last tool with the same name
        will be used.
      `;
        }
        toolsMap.set(tool.name, tool);
    }
    do {
        // Main loop - execute as many times as the model requests tools
        let allowTools = true;
        if (
        // If there is a defined number of max predictions,
        baseOpts.maxPredictionRounds !== undefined &&
            // ... and this is the last chance to perform predictions, don't allow the model to use
            // tools.
            predictionsPerformed + 1 >= baseOpts.maxPredictionRounds) {
            allowTools = false;
        }
        // Start the prediction
        let finished = false;
        let firstTokenTriggered = false;
        const contentArray = [];
        const reasoningContentArray = [];
        const nonReasoningContentArray = [];
        const toolCallRequests = [];
        let nextToolCallIndex = 0;
        const toolCallResults = [];
        /**
         * All promises that need to be awaited. Once they are done, they will add their own results
         * to the toolCallResults array in-place.
         */
        const toolCallPromises = [];
        /**
         * The promise that represents the prediction itself (The RPC call).
         */
        const { promise: predictionPromise, resolve: predictionResolve, reject: predictionReject, } = makePromise();
        /**
         * The final promise that will be awaited on for this prediction. It is resolved when the
         * prediction is done and all tool calls have been resolved.
         */
        const { promise: finalPromise, resolve: finalResolve, reject: finalReject, } = makePromise();
        const internalHandleInvalidToolCallRequest = async (error, request, 
        /**
         * In the case this tool call got a replacement, the index to use.
         */
        toolCallIndex) => {
            let result;
            try {
                result = await (baseOpts.handleInvalidToolRequest ?? defaultHandleInvalidToolRequest)(error, request);
            }
            catch (error) {
                if (abortController.signal.aborted) {
                    throw abortController.signal.reason;
                }
                abortController.abort();
                throw error; // Rethrow the error.
            }
            if (result === undefined) {
                // No replacement.
                return;
            }
            let resultString;
            try {
                resultString = JSON.stringify(result);
            }
            catch (error) {
                abortController.abort();
                throw makePrettyError("handleInvalidToolRequest returned a value that cannot be converted to JSON.", stack);
            }
            // The handleInvalidToolRequest has returned a "replacement"
            if (request === undefined) {
                // We cannot provide a result to a tool call that has failed to parse.
                logger.warnText `
          The "handleInvalidToolRequest" callback has returned a result, but the tool request has
          completely failed to parse, thus LM Studio cannot provide the result to the tool call.
          Please avoid returning a result when the second parameter of the callback is undefined.
          See the documentation for "handleInvalidToolRequest" for more information.
        `;
            }
            else {
                toolCallResults.push({
                    index: toolCallIndex,
                    data: {
                        type: "toolCallResult",
                        toolCallId: request.id,
                        content: resultString,
                    },
                });
                nextToolCallIndex++;
            }
        };
        abortController.signal.throwIfAborted();
        // Round start callback
        safeCallCallback(logger, "onRoundStart", baseOpts.onRoundStart, [predictionsPerformed]);
        let isGeneratingToolCall = false;
        /**
         * Abort controller for the current round.
         */
        const roundAbortController = new AbortController();
        const queue = baseOpts.allowParallelToolExecution
            ? new NoQueueQueue()
            : new FIFOQueue();
        let receivedEagerToolNameReporting = false;
        let receivedToolArgumentsStreaming = false;
        predictImpl({
            allowTools,
            history: accessMaybeMutableInternals(mutableChat)._internalGetData(),
            signal: roundAbortController.signal,
            handleFragment: fragment => {
                if (!firstTokenTriggered) {
                    firstTokenTriggered = true;
                    safeCallCallback(logger, "onFirstToken", baseOpts.onFirstToken, [predictionsPerformed]);
                }
                safeCallCallback(logger, "onFragment", baseOpts.onPredictionFragment, [
                    { roundIndex: predictionsPerformed, ...fragment },
                ]);
                contentArray.push(fragment.content);
                if (!fragment.isStructural) {
                    if (fragment.reasoningType === "reasoning") {
                        reasoningContentArray.push(fragment.content);
                    }
                    else {
                        nonReasoningContentArray.push(fragment.content);
                    }
                }
            },
            handlePromptProcessingProgress: progress => {
                safeCallCallback(logger, "onPromptProcessingProgress", baseOpts.onPromptProcessingProgress, [predictionsPerformed, progress]);
            },
            handleToolCallGenerationStart: toolCallId => {
                currentCallId = callIdGiver.next();
                receivedEagerToolNameReporting = false;
                receivedToolArgumentsStreaming = false;
                isGeneratingToolCall = true;
                safeCallCallback(logger, "onToolCallRequestStart", baseOpts.onToolCallRequestStart, [
                    predictionsPerformed,
                    currentCallId,
                    { toolCallId: toolCallId },
                ]);
            },
            handleToolCallGenerationNameReceived: name => {
                receivedEagerToolNameReporting = true;
                safeCallCallback(logger, "onToolCallRequestNameReceived", baseOpts.onToolCallRequestNameReceived, [predictionsPerformed, currentCallId, name]);
            },
            handleToolCallGenerationArgumentFragmentGenerated: content => {
                receivedToolArgumentsStreaming = true;
                safeCallCallback(logger, "onToolCallRequestArgumentFragmentGenerated", baseOpts.onToolCallRequestArgumentFragmentGenerated, [predictionsPerformed, currentCallId, content]);
            },
            handleToolCallGenerationEnd: (request, rawContent) => {
                const callId = currentCallId;
                isGeneratingToolCall = false;
                const toolCallIndex = nextToolCallIndex;
                nextToolCallIndex++;
                if (!receivedEagerToolNameReporting) {
                    // If eager name reporting not received, report it.
                    safeCallCallback(logger, "onToolCallRequestNameReceived", baseOpts.onToolCallRequestNameReceived, [predictionsPerformed, callId, request.name]);
                }
                if (!receivedToolArgumentsStreaming) {
                    // If arguments streaming not received, just pretend we have received all the arguments
                    // as a single JSON
                    safeCallCallback(logger, "onToolCallRequestArgumentFragmentGenerated", baseOpts.onToolCallRequestArgumentFragmentGenerated, [predictionsPerformed, callId, JSON.stringify(request.arguments ?? {}, null, 2)]);
                }
                const pushedRequest = { ...request };
                // We have now received a tool call request. Now let's see if we can call the tool and
                // get the result.
                toolCallRequests.push(pushedRequest);
                const tool = toolsMap.get(request.name);
                if (tool === undefined) {
                    // Tool does not exist.
                    const toolCallRequestError = new ToolCallRequestError(`Cannot find tool with name ${request.name}.`, rawContent);
                    toolCallPromises.push(internalHandleInvalidToolCallRequest(toolCallRequestError, request, toolCallIndex).catch(finalReject));
                    safeCallCallback(logger, "onToolCallRequestFailure", baseOpts.onToolCallRequestFailure, [
                        predictionsPerformed,
                        callId,
                        toolCallRequestError,
                    ]);
                    return;
                }
                // Try check the parameters:
                try {
                    tool.checkParameters(pushedRequest.arguments); // Defaults to empty object
                }
                catch (error) {
                    // Failed to parse the parameters
                    const toolCallRequestError = new ToolCallRequestError(error.message, rawContent);
                    toolCallPromises.push(internalHandleInvalidToolCallRequest(toolCallRequestError, request, toolCallIndex).catch(finalReject));
                    safeCallCallback(logger, "onToolCallRequestFailure", baseOpts.onToolCallRequestFailure, [
                        predictionsPerformed,
                        callId,
                        toolCallRequestError,
                    ]);
                    return;
                }
                const toolCallContext = new SimpleToolCallContext(new SimpleLogger(`Tool(${request.name})`, logger), abortController.signal, callId);
                const isQueued = queue.needsQueueing();
                safeCallCallback(logger, "onToolCallRequestEnd", baseOpts.onToolCallRequestEnd, [
                    predictionsPerformed,
                    callId,
                    {
                        isQueued,
                        toolCallRequest: request,
                        rawContent,
                    },
                ]);
                // We have successfully parsed the parameters. Let's call the tool.
                toolCallPromises.push(queue
                    .runInQueue(async () => {
                    // Emit the dequeued event if the tool call was queued.
                    if (isQueued) {
                        safeCallCallback(logger, "onToolCallRequestDequeued", baseOpts.onToolCallRequestDequeued, [predictionsPerformed, callId]);
                    }
                    // Guard the tool call if have a tool call guard.
                    if (baseOpts.guardToolCall !== undefined) {
                        const resultContainer = [null];
                        await baseOpts.guardToolCall(predictionsPerformed, callId, new GuardToolCallController(request, tool, resultContainer));
                        if (resultContainer[0] === null) {
                            // The guard did not return anything, thus we will report this error.
                            throw makeTitledPrettyError("Tool call guard did not allow or deny the tool call.", text `
                      The \`guardToolCall\` handler must call one of the methods on the controller
                      to allow or deny the tool call.
                    `, stack);
                        }
                        const guardResult = resultContainer[0];
                        const guardResultType = guardResult.type;
                        switch (guardResultType) {
                            case "allow": {
                                // 1. The guard allowed the tool call without overriding the parameters. In this
                                //    case, we will use the original parameters.
                                break;
                            }
                            case "allowAndOverrideParameters": {
                                // 2. The guard allowed the tool call and provided new parameters. In this case,
                                //    we will use the new parameters. This will update the request in-place.
                                pushedRequest.arguments = guardResult.parameters;
                                break;
                            }
                            case "deny": {
                                // 3. The guard denied the tool call. In this case, we will early return and not
                                //    call the tool.
                                toolCallResults.push({
                                    index: toolCallIndex,
                                    data: {
                                        type: "toolCallResult",
                                        toolCallId: request.id,
                                        content: JSON.stringify({
                                            error: guardResult.reason,
                                        }),
                                    },
                                });
                                return;
                            }
                        }
                    }
                    // Now we need to call RequestFinalized
                    safeCallCallback(logger, "onToolCallRequestFinalized", baseOpts.onToolCallRequestFinalized, [
                        predictionsPerformed,
                        callId,
                        {
                            toolCallRequest: request,
                            rawContent,
                        },
                    ]);
                    let result;
                    try {
                        result = await tool.implementation(pushedRequest.arguments ?? {}, toolCallContext);
                    }
                    catch (error) {
                        if (!(error instanceof UnimplementedToolError)) {
                            throw error;
                        }
                        hasCalledUnimplementedTool = true;
                    }
                    let resultString;
                    if (result === undefined) {
                        resultString = "undefined";
                    }
                    else {
                        try {
                            resultString = JSON.stringify(result);
                        }
                        catch (error) {
                            throw makePrettyError(`Return value of tool ${tool.name} cannot be converted to JSON.`, stack);
                        }
                    }
                    toolCallResults.push({
                        index: toolCallIndex,
                        data: {
                            type: "toolCallResult",
                            toolCallId: request.id,
                            content: resultString,
                        },
                    });
                }, abortController.signal)
                    .catch(finalReject));
            },
            handleToolCallGenerationFailed: (error, rawContent) => {
                isGeneratingToolCall = false;
                const toolCallRequestError = new ToolCallRequestError(error.message, rawContent);
                toolCallPromises.push(internalHandleInvalidToolCallRequest(toolCallRequestError, 
                // We don't have a request in this because the model has failed miserably.
                undefined, 
                // Tool call index. Doesn't matter because if there is no request, there cannot be
                // a replacement.
                0).catch(finalReject));
                safeCallCallback(logger, "onToolCallRequestFailure", baseOpts.onToolCallRequestFailure, [
                    predictionsPerformed,
                    currentCallId,
                    toolCallRequestError,
                ]);
            },
            handlePredictionEnd: endPacket => {
                const predictionResult = makePredictionResult({
                    endPacket,
                    content: contentArray.join(""),
                    reasoningContent: reasoningContentArray.join(""),
                    nonReasoningContent: nonReasoningContentArray.join(""),
                    predictionsPerformed,
                });
                safeCallCallback(logger, "onPredictionCompleted", baseOpts.onPredictionCompleted, [
                    predictionResult,
                ]);
                predictionResolve();
            },
            handleError: error => {
                if (isGeneratingToolCall) {
                    const toolCallRequestError = new ToolCallRequestError(`Generation failed: ${error.message}`, undefined);
                    // Notify tool call generation failure.
                    isGeneratingToolCall = false;
                    safeCallCallback(logger, "onToolCallRequestFailure", baseOpts.onToolCallRequestFailure, [
                        predictionsPerformed,
                        currentCallId,
                        toolCallRequestError,
                    ]);
                }
                finished = true;
                predictionReject(error);
            },
        });
        const abortListener = () => {
            if (finished) {
                return;
            }
            finished = true;
            roundAbortController.abort(abortController.signal.reason);
        };
        abortController.signal.addEventListener("abort", abortListener);
        predictionPromise
            .then(() => {
            // Append and emit the assistant message.
            const assistantMessage = ChatMessage.from({
                role: "assistant",
                content: [
                    {
                        type: "text",
                        text: contentArray.join(""),
                    },
                    ...toolCallRequests.map(toolCallRequest => ({
                        type: "toolCallRequest",
                        toolCallRequest,
                    })),
                ],
            });
            mutableChat.append(assistantMessage.asMutableCopy());
            safeCallCallback(logger, "onMessage", baseOpts.onMessage, [assistantMessage]);
        })
            // When the prediction is completed, wait for all tool calls to be completed.
            .then(() => Promise.all(toolCallPromises))
            .then(() => finalResolve(), finalReject);
        await finalPromise;
        shouldContinue = false;
        if (toolCallResults.length > 0) {
            // Sort the tool call results back into the order they were requested.
            toolCallResults.sort((a, b) => a.index - b.index);
            // Emit the tool call results.
            const toolMessage = ChatMessage.from({
                role: "tool",
                content: toolCallResults.map(r => r.data),
            });
            mutableChat.append(toolMessage.asMutableCopy());
            safeCallCallback(logger, "onMessage", baseOpts.onMessage, [toolMessage]);
            shouldContinue = true;
        }
        safeCallCallback(logger, "onRoundEnd", baseOpts.onRoundEnd, [predictionsPerformed]);
        predictionsPerformed++;
        // Don't continue if we've reached the max predictions.
        if (baseOpts.maxPredictionRounds !== undefined &&
            predictionsPerformed >= baseOpts.maxPredictionRounds) {
            shouldContinue = false;
        }
        shouldContinue &&= !hasCalledUnimplementedTool; // Stop loop if unimplemented tool was called.
    } while (shouldContinue);
    return new ActResult(predictionsPerformed, (performance.now() - startTime) / 1_000);
}

/**
 * Represents the result of an LLM prediction.
 *
 * The most notably property is {@link PredictionResult#content}, which contains the generated text.
 * Additionally, the {@link PredictionResult#stats} property contains statistics about the
 * prediction.
 *
 * @public
 */
class PredictionResult {
    constructor(
    /**
     * The newly generated text as predicted by the LLM.
     */
    content, 
    /**
     * Part of the generated text that is "reasoning" content. For example, text inside <think>
     * tags. You can adjust what is considered reasoning content by changing the `reasoningParsing`
     * field when performing the prediction.
     */
    reasoningContent, 
    /**
     * Part of the generated that is not "reasoning" content. For example, text outside <think>
     * tags. You can adjust what is considered reasoning content by changing the `reasoningParsing`
     * field when performing the prediction.
     */
    nonReasoningContent, 
    /**
     * Statistics about the prediction.
     */
    stats, 
    /**
     * Information about the model used for the prediction.
     */
    modelInfo, 
    /**
     * The 0-indexed round index of the prediction in multi-round scenario (for example,
     * `.act`). Will always be 0 for single-round predictions such as `.respond` or `.complete`.
     */
    roundIndex, 
    /**
     * The configuration used to load the model. Not stable, subject to change.
     *
     * @deprecated [DEP-RAW-CONFIG] Raw config access API is still in active development. Stay
     * turned for updates.
     */
    loadConfig, 
    /**
     * The configuration used for the prediction. Not stable, subject to change.
     *
     * @deprecated [DEP-RAW-CONFIG] Raw config access API is still in active development. Stay
     * turned for updates.
     */
    predictionConfig) {
        this.content = content;
        this.reasoningContent = reasoningContent;
        this.nonReasoningContent = nonReasoningContent;
        this.stats = stats;
        this.modelInfo = modelInfo;
        this.roundIndex = roundIndex;
        this.loadConfig = loadConfig;
        this.predictionConfig = predictionConfig;
    }
}
/**
 * Result of a typed structured prediction. In addition to a regular {@link PredictionResult}, there
 * is one additional field: {@link StructuredPredictionResult#parsed}.
 *
 * To enable typed structured prediction, you should pass in a zod schema as the structured option
 * when constructing the prediction config.
 *
 * @public
 */
class StructuredPredictionResult extends PredictionResult {
    constructor(content, reasoningContent, nonReasoningContent, stats, modelInfo, roundIndex, loadConfig, predictionConfig, 
    /**
     * Parsed result of the structured output.
     */
    parsed) {
        super(content, reasoningContent, nonReasoningContent, stats, modelInfo, roundIndex, loadConfig, predictionConfig);
        this.parsed = parsed;
    }
}

/**
 * Represents an ongoing prediction.
 *
 * Note, this class is Promise-like, meaning you can use it as a promise. It resolves to a
 * {@link PredictionResult}, which contains the generated text in the `.content` property. Example
 * usage:
 *
 * ```typescript
 * const result = await model.complete("When will The Winds of Winter be released?");
 * console.log(result.content);
 * ```
 *
 * Or you can use instances methods like `then` and `catch` to handle the result or error of the
 * prediction.
 *
 * ```typescript
 * model.complete("When will The Winds of Winter be released?")
 *  .then(result =\> console.log(result.content))
 *  .catch(error =\> console.error(error));
 * ```
 *
 * Alternatively, you can also stream the result (process the results as more content is being
 * generated). For example:
 *
 * ```typescript
 * for await (const { content } of model.complete("When will The Winds of Winter be released?")) {
 *   process.stdout.write(content);
 * }
 * ```
 *
 * @public
 */
class OngoingPrediction extends StreamablePromise {
    async collect(fragments) {
        const content = fragments.map(({ content }) => content).join("");
        const reasoningContent = fragments
            .filter(({ isStructural }) => !isStructural)
            .filter(({ reasoningType }) => reasoningType === "reasoning")
            .map(({ content }) => content)
            .join("");
        const nonReasoningContent = fragments
            .filter(({ isStructural }) => !isStructural)
            .filter(({ reasoningType }) => reasoningType === "none")
            .map(({ content }) => content)
            .join("");
        if (this.stats === null) {
            throw new Error("Stats should not be null");
        }
        if (this.modelInfo === null) {
            throw new Error("Model info should not be null");
        }
        if (this.loadModelConfig === null) {
            throw new Error("Load model config should not be null");
        }
        if (this.predictionConfig === null) {
            throw new Error("Prediction config should not be null");
        }
        if (this.parser === null) {
            return new PredictionResult(content, reasoningContent, nonReasoningContent, this.stats, this.modelInfo, 
            // Currently, OngoingPrediction is only used with single round predictions. Thus always
            // use roundIndex 0.
            /* roundIndex */ 0, this.loadModelConfig, this.predictionConfig);
        }
        else {
            return new StructuredPredictionResult(content, reasoningContent, nonReasoningContent, this.stats, this.modelInfo, 
            // Currently, OngoingPrediction is only used with single round predictions. Thus always
            // use roundIndex 0.
            /* predictionIndex */ 0, this.loadModelConfig, this.predictionConfig, this.parser(content));
        }
    }
    constructor(onCancel, parser) {
        super();
        this.onCancel = onCancel;
        this.parser = parser;
        this.stats = null;
        this.modelInfo = null;
        this.loadModelConfig = null;
        this.predictionConfig = null;
    }
    /** @internal */
    static create(onCancel, parser) {
        const ongoingPrediction = new OngoingPrediction(onCancel, parser);
        const finished = (stats, modelInfo, loadModelConfig, predictionConfig) => {
            ongoingPrediction.stats = stats;
            ongoingPrediction.modelInfo = modelInfo;
            ongoingPrediction.loadModelConfig = loadModelConfig;
            ongoingPrediction.predictionConfig = predictionConfig;
            ongoingPrediction.finished();
        };
        const failed = (error) => ongoingPrediction.finished(error);
        const push = (fragment) => ongoingPrediction.push(fragment);
        return { ongoingPrediction, finished, failed, push };
    }
    /**
     * Get the final prediction results. If you have been streaming the results, awaiting on this
     * method will take no extra effort, as the results are already available in the internal buffer.
     *
     * Example:
     *
     * ```typescript
     * const prediction = model.complete("When will The Winds of Winter be released?");
     * for await (const { content } of prediction) {
     *   process.stdout.write(content);
     * }
     * const result = await prediction.result();
     * console.log(result.stats);
     * ```
     *
     * Technically, awaiting on this method is the same as awaiting on the instance itself:
     *
     * ```typescript
     * await prediction.result();
     *
     * // Is the same as:
     *
     * await prediction;
     * ```
     */
    async result() {
        return (await this);
    }
    /**
     * Cancels the prediction. This will stop the prediction with stop reason `userStopped`. See
     * {@link LLMPredictionStopReason} for other reasons that a prediction might stop.
     */
    async cancel() {
        this.onCancel();
    }
}

const llmPredictionOptsSchema = llmPredictionConfigInputSchema.extend({
    onPromptProcessingProgress: zod.z.function().optional(),
    onFirstToken: zod.z.function().optional(),
    onPredictionFragment: zod.z.function().optional(),
    onToolCallRequestStart: zod.z.function().optional(),
    onToolCallRequestNameReceived: zod.z.function().optional(),
    onToolCallRequestArgumentFragmentGenerated: zod.z.function().optional(),
    onToolCallRequestEnd: zod.z.function().optional(),
    onToolCallRequestFailure: zod.z.function().optional(),
    signal: zod.z.instanceof(AbortSignal).optional(),
    preset: zod.z.string().optional(),
});
function splitPredictionOpts(opts) {
    const { onPromptProcessingProgress, onFirstToken, onPredictionFragment, onToolCallRequestStart, onToolCallRequestNameReceived, onToolCallRequestArgumentFragmentGenerated, onToolCallRequestEnd, onToolCallRequestFailure, signal, preset, ...config } = opts;
    return [
        config,
        {
            onPromptProcessingProgress,
            onFirstToken,
            onPredictionFragment,
            onToolCallRequestStart,
            onToolCallRequestNameReceived,
            onToolCallRequestArgumentFragmentGenerated,
            onToolCallRequestEnd,
            onToolCallRequestFailure,
            signal,
            preset,
        },
    ];
}
const llmRespondOptsSchema = llmPredictionOptsSchema.extend({
    onMessage: zod.z.function().optional(),
    onToolCallRequestStart: zod.z.function().optional(),
    onToolCallRequestNameReceived: zod.z.function().optional(),
    onToolCallRequestArgumentFragmentGenerated: zod.z.function().optional(),
    onToolCallRequestEnd: zod.z.function().optional(),
    onToolCallRequestFailure: zod.z.function().optional(),
});
/**
 * Split a llmRespondOpts into its parts.
 */
function splitRespondOpts(opts) {
    const { onMessage, ...remaining } = opts;
    const [config, llmPredictionOpts] = splitPredictionOpts(remaining);
    return [
        config,
        llmPredictionOpts,
        {
            onMessage,
        },
    ];
}
const llmActionOptsSchema = llmPredictionConfigInputSchema
    .extend(llmActBaseOptsSchema.shape)
    .extend({
    preset: zod.z.string().optional(),
});
function splitActOpts(opts) {
    const { onFirstToken, onPredictionFragment, onMessage, onRoundStart, onRoundEnd, onPredictionCompleted, onPromptProcessingProgress, onToolCallRequestStart, onToolCallRequestNameReceived, onToolCallRequestArgumentFragmentGenerated, onToolCallRequestEnd, onToolCallRequestFinalized, onToolCallRequestFailure, onToolCallRequestDequeued, guardToolCall, handleInvalidToolRequest, maxPredictionRounds, signal, preset, allowParallelToolExecution, ...config } = opts;
    return [
        config,
        {
            onFirstToken,
            onPredictionFragment,
            onMessage,
            onRoundStart,
            onRoundEnd,
            onPredictionCompleted,
            onPromptProcessingProgress,
            onToolCallRequestStart,
            onToolCallRequestNameReceived,
            onToolCallRequestArgumentFragmentGenerated,
            onToolCallRequestEnd,
            onToolCallRequestFinalized,
            onToolCallRequestFailure,
            onToolCallRequestDequeued,
            guardToolCall,
            handleInvalidToolRequest,
            maxPredictionRounds,
            signal,
            preset,
            allowParallelToolExecution,
        },
    ];
}
const noFormattingTemplate = text `
  {% for message in messages %}{{ message['content'] }}{% endfor %}
`;
/**
 * This represents a set of requirements for a model. It is not tied to a specific model, but rather
 * to a set of requirements that a model must satisfy.
 *
 * For example, if you got the model via `client.llm.model("my-identifier")`, you will get a
 * `LLMDynamicHandle` for the model with the identifier `my-identifier`. If the model is unloaded,
 * and another model is loaded with the same identifier, using the same `LLMDynamicHandle` will use
 * the new model.
 *
 * @public
 */
class LLMDynamicHandle extends DynamicHandle {
    /**
     * Don't construct this on your own. Use {@link LLMNamespace#model} or
     * {@link LLMNamespace#createDynamicHandle} instead.
     *
     * @internal
     */
    constructor(
    /** @internal */
    port, 
    /** @internal */
    specifier, 
    /** @internal */
    validator, 
    /** @internal */
    logger = new SimpleLogger(`LLMModel`)) {
        super(port, specifier);
        this.validator = validator;
        this.logger = logger;
        /** @internal */
        this.internalKVConfigStack = { layers: [] };
        /** @internal */
        this.internalIgnoreServerSessionConfig = undefined;
    }
    /** @internal */
    internalPredict(history, predictionConfigStack, cancelEvent, extraOpts, onFragment, onFinished, onError) {
        let finished = false;
        let firstTokenTriggered = false;
        let currentCallId = null;
        let receivedEagerToolNameReporting = false;
        let receivedToolArgumentsStreaming = false;
        const channel = this.port.createChannel("predict", {
            modelSpecifier: this.specifier,
            history,
            predictionConfigStack,
            fuzzyPresetIdentifier: extraOpts.preset,
            ignoreServerSessionConfig: this.internalIgnoreServerSessionConfig,
        }, message => {
            switch (message.type) {
                case "fragment": {
                    if (!firstTokenTriggered) {
                        firstTokenTriggered = true;
                        safeCallCallback(this.logger, "onFirstToken", extraOpts.onFirstToken, []);
                    }
                    safeCallCallback(this.logger, "onFragment", extraOpts.onPredictionFragment, [
                        message.fragment,
                    ]);
                    onFragment(message.fragment);
                    break;
                }
                case "promptProcessingProgress": {
                    safeCallCallback(this.logger, "onPromptProcessingProgress", extraOpts.onPromptProcessingProgress, [message.progress]);
                    break;
                }
                case "toolCallGenerationStart": {
                    if (currentCallId === null) {
                        currentCallId = 0;
                    }
                    else {
                        currentCallId++;
                    }
                    receivedEagerToolNameReporting = false;
                    receivedToolArgumentsStreaming = false;
                    safeCallCallback(this.logger, "onToolCallGenerationStart", extraOpts.onToolCallRequestStart, [currentCallId, { toolCallId: message.toolCallId }]);
                    break;
                }
                case "toolCallGenerationNameReceived": {
                    receivedEagerToolNameReporting = true;
                    safeCallCallback(this.logger, "onToolCallGenerationNameReceived", extraOpts.onToolCallRequestNameReceived, [currentCallId ?? -1, message.name]);
                    break;
                }
                case "toolCallGenerationArgumentFragmentGenerated": {
                    receivedToolArgumentsStreaming = true;
                    safeCallCallback(this.logger, "onToolCallGenerationArgumentFragmentGenerated", extraOpts.onToolCallRequestArgumentFragmentGenerated, [currentCallId ?? -1, message.content]);
                    break;
                }
                case "toolCallGenerationEnd": {
                    if (!receivedEagerToolNameReporting) {
                        // If eager name reporting not received, report it.
                        safeCallCallback(this.logger, "onToolCallGenerationNameReceived", extraOpts.onToolCallRequestNameReceived, [currentCallId ?? -1, message.toolCallRequest.name]);
                    }
                    if (!receivedToolArgumentsStreaming) {
                        // If arguments streaming not received, just pretend we have received all the
                        // arguments as a single JSON
                        safeCallCallback(this.logger, "onToolCallGenerationArgumentFragmentGenerated", extraOpts.onToolCallRequestArgumentFragmentGenerated, [
                            currentCallId ?? -1,
                            JSON.stringify(message.toolCallRequest.arguments ?? {}, null, 2),
                        ]);
                    }
                    safeCallCallback(this.logger, "onToolCallGenerationEnd", extraOpts.onToolCallRequestEnd, [
                        currentCallId ?? -1,
                        { toolCallRequest: message.toolCallRequest, rawContent: message.rawContent },
                    ]);
                    break;
                }
                case "toolCallGenerationFailed": {
                    const toolCallRequestError = new ToolCallRequestError(fromSerializedError(message.error).message, message.rawContent);
                    safeCallCallback(this.logger, "onToolCallGenerationFailed", extraOpts.onToolCallRequestFailure, [currentCallId ?? -1, toolCallRequestError]);
                    break;
                }
                case "success": {
                    finished = true;
                    onFinished(message.stats, message.modelInfo, message.loadModelConfig, message.predictionConfig);
                    break;
                }
            }
        }, { stack: getCurrentStack(2) });
        cancelEvent.subscribeOnce(() => {
            if (finished) {
                return;
            }
            channel.send({ type: "cancel" });
        });
        channel.onError.subscribeOnce(onError);
    }
    predictionConfigInputToKVConfig(config) {
        let structuredField = undefined;
        if (typeof config.structured?.parse === "function") {
            structuredField = {
                type: "json",
                jsonSchema: zodToJsonSchema.zodToJsonSchema(config.structured),
            };
        }
        else {
            structuredField = config.structured;
        }
        const convertedConfig = {
            ...config,
            structured: structuredField,
        };
        return llmPredictionConfigToKVConfig(convertedConfig);
    }
    createZodParser(zodSchema) {
        return content => {
            try {
                return zodSchema.parse(JSON.parse(content));
            }
            catch (e) {
                throw new Error("Failed to parse structured output: " + JSON.stringify(content), {
                    cause: e,
                });
            }
        };
    }
    /**
     * Use the loaded model to predict text.
     *
     * This method returns an {@link OngoingPrediction} object. An ongoing prediction can be used as a
     * promise (if you only care about the final result) or as an async iterable (if you want to
     * stream the results as they are being generated).
     *
     * Example usage as a promise (Resolves to a {@link PredictionResult}):
     *
     * ```typescript
     * const result = await model.complete("When will The Winds of Winter be released?");
     * console.log(result.content);
     * ```
     *
     * Or
     *
     * ```typescript
     * model.complete("When will The Winds of Winter be released?")
     *  .then(result =\> console.log(result.content))
     *  .catch(error =\> console.error(error));
     * ```
     *
     * Example usage as an async iterable (streaming):
     *
     * ```typescript
     * for await (const { content } of model.complete("When will The Winds of Winter be released?")) {
     *   process.stdout.write(content);
     * }
     * ```
     *
     * If you wish to stream the result, but also getting the final prediction results (for example,
     * you wish to get the prediction stats), you can use the following pattern:
     *
     * ```typescript
     * const prediction = model.complete("When will The Winds of Winter be released?");
     * for await (const { content } of prediction) {
     *   process.stdout.write(content);
     * }
     * const result = await prediction.result();
     * console.log(result.stats);
     * ```
     *
     * @param prompt - The prompt to use for prediction.
     * @param opts - Options for the prediction.
     */
    complete(prompt, opts = {}) {
        const stack = getCurrentStack(1);
        [prompt, opts] = this.validator.validateMethodParamsOrThrow("model", "complete", ["prompt", "opts"], [zod.z.string(), llmPredictionOptsSchema], [prompt, opts], stack);
        const [config, extraOpts] = splitPredictionOpts(opts);
        const [cancelEvent, emitCancelEvent] = BufferedEvent.create();
        if (extraOpts.signal !== undefined) {
            if (extraOpts.signal.aborted) {
                // If the signal is already aborted, we need to cancel the prediction immediately.
                emitCancelEvent();
            }
            else {
                extraOpts.signal.addEventListener("abort", () => {
                    emitCancelEvent();
                }, { once: true });
            }
        }
        const zodSchemaParseResult = zodSchemaSchema.safeParse(config.structured);
        const { ongoingPrediction, finished, failed, push } = OngoingPrediction.create(emitCancelEvent, !zodSchemaParseResult.success ? null : this.createZodParser(zodSchemaParseResult.data));
        this.internalPredict(this.resolveCompletionContext(prompt), {
            layers: [
                ...this.internalKVConfigStack.layers,
                {
                    layerName: "apiOverride",
                    config: this.predictionConfigInputToKVConfig({
                        // If the user did not specify `stopStrings`, we default to an empty array. This is to
                        // prevent the model from using the value set in the preset.
                        stopStrings: [],
                        ...config,
                    }),
                },
                {
                    layerName: "completeModeFormatting",
                    config: llmSharedPredictionConfigSchematics.buildPartialConfig({
                        promptTemplate: {
                            type: "jinja",
                            jinjaPromptTemplate: {
                                template: noFormattingTemplate,
                            },
                            stopStrings: [],
                        },
                    }),
                },
            ],
        }, cancelEvent, extraOpts, fragment => push(fragment), (stats, modelInfo, loadModelConfig, predictionConfig) => finished(stats, modelInfo, loadModelConfig, predictionConfig), error => failed(error));
        return ongoingPrediction;
    }
    resolveCompletionContext(contextInput) {
        return {
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: contextInput }],
                },
            ],
        };
    }
    /**
     * Use the loaded model to generate a response based on the given history.
     *
     * This method returns an {@link OngoingPrediction} object. An ongoing prediction can be used as a
     * promise (if you only care about the final result) or as an async iterable (if you want to
     * stream the results as they are being generated).
     *
     * Example usage as a promise (Resolves to a {@link PredictionResult}):
     *
     * ```typescript
     * const history = [{ role: 'user', content: "When will The Winds of Winter be released?" }];
     * const result = await model.respond(history);
     * console.log(result.content);
     * ```
     *
     * Or
     *
     * ```typescript
     * const history = [{ role: 'user', content: "When will The Winds of Winter be released?" }];
     * model.respond(history)
     *  .then(result => console.log(result.content))
     *  .catch(error => console.error(error));
     * ```
     *
     * Example usage as an async iterable (streaming):
     *
     * ```typescript
     * const history = [{ role: 'user', content: "When will The Winds of Winter be released?" }];
     * for await (const { content } of model.respond(history)) {
     *   process.stdout.write(content);
     * }
     * ```
     *
     * If you wish to stream the result, but also getting the final prediction results (for example,
     * you wish to get the prediction stats), you can use the following pattern:
     *
     * ```typescript
     * const history = [{ role: 'user', content: "When will The Winds of Winter be released?" }];
     * const prediction = model.respond(history);
     * for await (const { content } of prediction) {
     *   process.stdout.write(content);
     * }
     * const result = await prediction;
     * console.log(result.stats);
     * ```
     *
     * @param chat - The LLMChatHistory array to use for generating a response.
     * @param opts - Options for the prediction.
     */
    respond(chat, opts = {}) {
        const stack = getCurrentStack(1);
        [chat, opts] = this.validator.validateMethodParamsOrThrow("model", "respond", ["chat", "opts"], [chatHistoryLikeSchema, llmRespondOptsSchema], [chat, opts], stack);
        const [cancelEvent, emitCancelEvent] = BufferedEvent.create();
        const [config, predictionOpts, respondOpts] = splitRespondOpts(opts);
        if (predictionOpts.signal !== undefined) {
            if (predictionOpts.signal.aborted) {
                // If the signal is already aborted, we need to cancel the prediction immediately.
                emitCancelEvent();
            }
            else {
                predictionOpts.signal.addEventListener("abort", () => {
                    emitCancelEvent();
                }, { once: true });
            }
        }
        const zodSchemaParseResult = zodSchemaSchema.safeParse(config.structured);
        const { ongoingPrediction, finished, failed, push } = OngoingPrediction.create(emitCancelEvent, !zodSchemaParseResult.success ? null : this.createZodParser(zodSchemaParseResult.data));
        this.internalPredict(accessMaybeMutableInternals(Chat.from(chat))._internalGetData(), addKVConfigToStack(this.internalKVConfigStack, "apiOverride", this.predictionConfigInputToKVConfig(config)), cancelEvent, predictionOpts, fragment => push(fragment), (stats, modelInfo, loadModelConfig, predictionConfig) => finished(stats, modelInfo, loadModelConfig, predictionConfig), error => failed(error));
        ongoingPrediction.then(result => {
            // Call the onMessage callback with the result.
            safeCallCallback(this.logger, "onMessage", respondOpts.onMessage, [
                ChatMessage.create("assistant", result.content),
            ]);
        }, () => { });
        return ongoingPrediction;
    }
    /**
     * @param chat - The LLMChatHistory array to act from as the base
     * @param tool - An array of tools that the model can use during the operation. You can create
     * tools by using the `tool` function.
     * @param opts - Additional options
     *
     * Example:
     *
     * ```
     * import { LMStudioClient, tool } from "@lmstudio/sdk";
     * import { z } from "zod";
     *
     * const client = new LMStudioClient();
     * const model = await client.llm.model();
     *
     * const additionTool = tool({
     *   name: "add",
     *   description: "Add two numbers",
     *   parameters: {
     *     a: z.number(),
     *     b: z.number(),
     *   },
     *   implementation: ({ a, b }) => a + b,
     * });
     *
     * await model.act("What is 1234 + 4321?", [additionTool], {
     *   onMessage: message => console.log(message.toString()),
     * });
     * ```
     */
    async act(chat, tools, opts = {}) {
        const startTime = performance.now();
        const stack = getCurrentStack(1);
        [chat, opts] = this.validator.validateMethodParamsOrThrow("model", "act", ["chat", "opts"], [chatHistoryLikeSchema, llmActionOptsSchema], [chat, opts], stack);
        const [config, { preset, ...baseOpts }] = splitActOpts(opts);
        if (config.structured !== undefined &&
            config.structured.type !== "none" &&
            tools.length > 0) {
            throw makePrettyError("Structured output is currently not supported in .act() when there are tools.", stack);
        }
        if (config.structured !== undefined && config.structured.parse !== undefined) {
            throw makePrettyError("zod schema is not supported in .act().", stack);
        }
        if (config.rawTools !== undefined) {
            throw makePrettyError("`rawTools` is not supported in act. Use `tools` instead", stack);
        }
        let rawTools;
        if (tools.length === 0) {
            rawTools = { type: "none" };
        }
        else {
            rawTools = {
                type: "toolArray",
                tools: tools.map(toolToLLMTool),
            };
        }
        const configWithTools = addKVConfigToStack(this.internalKVConfigStack, "apiOverride", this.predictionConfigInputToKVConfig({
            ...config,
            rawTools,
        }));
        const configWithoutTools = addKVConfigToStack(this.internalKVConfigStack, "apiOverride", this.predictionConfigInputToKVConfig({
            ...config,
            rawTools: { type: "none" },
        }));
        return await internalAct(chat, tools, baseOpts, stack, this.logger, startTime, 
        // Implementation of the prediction function. This performs the prediction by creating a
        // predict channel and redirect the messages to the appropriate handlers.
        async ({ allowTools, history, signal, handleFragment, handlePromptProcessingProgress, handleToolCallGenerationStart, handleToolCallGenerationNameReceived, handleToolCallGenerationArgumentFragmentGenerated, handleToolCallGenerationEnd, handleToolCallGenerationFailed, handlePredictionEnd, handleError, }) => {
            // Use predict channel
            const channel = this.port.createChannel("predict", {
                modelSpecifier: this.specifier,
                history,
                predictionConfigStack: allowTools ? configWithTools : configWithoutTools,
                fuzzyPresetIdentifier: preset,
                ignoreServerSessionConfig: this.internalIgnoreServerSessionConfig,
            }, message => {
                const messageType = message.type;
                switch (messageType) {
                    case "fragment": {
                        handleFragment(message.fragment);
                        break;
                    }
                    case "promptProcessingProgress": {
                        handlePromptProcessingProgress(message.progress);
                        break;
                    }
                    case "toolCallGenerationStart": {
                        handleToolCallGenerationStart(message.toolCallId);
                        break;
                    }
                    case "toolCallGenerationNameReceived": {
                        handleToolCallGenerationNameReceived(message.name);
                        break;
                    }
                    case "toolCallGenerationArgumentFragmentGenerated": {
                        handleToolCallGenerationArgumentFragmentGenerated(message.content);
                        break;
                    }
                    case "toolCallGenerationEnd": {
                        handleToolCallGenerationEnd(message.toolCallRequest, message.rawContent);
                        break;
                    }
                    case "toolCallGenerationFailed": {
                        handleToolCallGenerationFailed(fromSerializedError(message.error), message.rawContent);
                        break;
                    }
                    case "success": {
                        // This is the end of the prediction. The following object is passed to the
                        // `makePredictionResult` function to create the final PredictionResult. (see below)
                        handlePredictionEnd({
                            stats: message.stats,
                            modelInfo: message.modelInfo,
                            loadModelConfig: message.loadModelConfig,
                            predictionConfig: message.predictionConfig,
                        });
                        break;
                    }
                }
            }, { stack });
            if (signal.aborted) {
                // If the signal is already aborted, we need to cancel the prediction immediately.
                channel.send({ type: "cancel" });
            }
            else {
                signal.addEventListener("abort", () => {
                    channel.send({ type: "cancel" });
                }, { once: true });
            }
            channel.onError.subscribeOnce(handleError);
        }, ({ endPacket, content, nonReasoningContent, reasoningContent, predictionsPerformed }) => {
            return new PredictionResult(content, reasoningContent, nonReasoningContent, endPacket.stats, endPacket.modelInfo, predictionsPerformed, endPacket.loadModelConfig, endPacket.predictionConfig);
        });
    }
    async getContextLength() {
        const stack = getCurrentStack(1);
        const loadConfig = await this.getLoadConfig(stack);
        return llmSharedLoadConfigSchematics.access(loadConfig, "contextLength");
    }
    async applyPromptTemplate(history, opts = {}) {
        const stack = getCurrentStack(1);
        [history, opts] = this.validator.validateMethodParamsOrThrow("model", "applyPromptTemplate", ["history", "opts"], [chatHistoryLikeSchema, llmApplyPromptTemplateOptsSchema], [history, opts], stack);
        return (await this.port.callRpc("applyPromptTemplate", {
            specifier: this.specifier,
            history: accessMaybeMutableInternals(Chat.from(history))._internalGetData(),
            predictionConfigStack: this.internalKVConfigStack,
            opts,
        }, {
            stack,
        })).formatted;
    }
    async tokenize(inputString) {
        const stack = getCurrentStack(1);
        inputString = this.validator.validateMethodParamOrThrow("model", "tokenize", "inputString", zod.z.string().or(zod.z.array(zod.z.string())), inputString, stack);
        if (Array.isArray(inputString)) {
            return (await Promise.all(inputString.map(s => this.port.callRpc("tokenize", { specifier: this.specifier, inputString: s }, { stack })))).map(r => r.tokens);
        }
        else {
            return (await this.port.callRpc("tokenize", {
                specifier: this.specifier,
                inputString,
            }, { stack })).tokens;
        }
    }
    async countTokens(inputString) {
        const stack = getCurrentStack(1);
        inputString = this.validator.validateMethodParamOrThrow("model", "countTokens", "inputString", zod.z.string(), inputString, stack);
        return (await this.port.callRpc("countTokens", {
            specifier: this.specifier,
            inputString,
        }, { stack })).tokenCount;
    }
    /**
     * Starts to eagerly preload a draft model. This is useful when you want a draft model to be ready
     * for speculative decoding.
     *
     * Preloading is done on a best-effort basis and may not always succeed. It is not guaranteed that
     * the draft model is actually loaded when this method returns. Thus, this method should only be
     * used as an optimization. The actual draft model used only depends on the parameter set when
     * performing the prediction.
     */
    async unstable_preloadDraftModel(draftModelKey) {
        const stack = getCurrentStack(1);
        draftModelKey = this.validator.validateMethodParamOrThrow("model", "unstable_preloadDraftModel", "draftModelKey", zod.z.string(), draftModelKey, stack);
        await this.port.callRpc("preloadDraftModel", { specifier: this.specifier, draftModelKey }, { stack });
    }
}

/**
 * Represents a specific loaded LLM. Most LLM related operations are inherited from
 * {@link LLMDynamicHandle}.
 *
 * @public
 */
class LLM extends LLMDynamicHandle {
    /** @internal */
    constructor(llmPort, info, validator, logger = new SimpleLogger(`LLM`)) {
        const specifier = {
            type: "instanceReference",
            instanceReference: info.instanceReference,
        };
        super(llmPort, specifier, validator, logger);
        this.identifier = info.identifier;
        this.path = info.path;
        this.modelKey = info.modelKey;
        this.format = info.format;
        this.displayName = info.displayName;
        this.sizeBytes = info.sizeBytes;
        this.vision = info.vision;
        this.trainedForToolUse = info.trainedForToolUse;
    }
    async unload() {
        const stack = getCurrentStack(1);
        await this.port.callRpc("unloadModel", { identifier: this.identifier }, { stack });
    }
    async getModelInfo() {
        const info = await super.getModelInfo();
        if (info === undefined) {
            const stack = getCurrentStack(1);
            throw makePrettyError("This model has already been unloaded", stack);
        }
        return info;
    }
}

/** @public */
class LLMNamespace extends ModelNamespace {
    constructor() {
        super(...arguments);
        /** @internal */
        this.namespace = "llm";
        /** @internal */
        this.defaultLoadConfig = {};
        /** @internal */
        this.loadModelConfigSchema = llmLoadModelConfigSchema;
    }
    /** @internal */
    loadConfigToKVConfig(config) {
        return llmLlamaMoeLoadConfigSchematics.buildPartialConfig({
            "contextLength": config.contextLength,
            "llama.evalBatchSize": config.evalBatchSize,
            "llama.acceleration.offloadRatio": config.gpu?.ratio,
            "numCpuExpertLayersRatio": config.gpu?.numCpuExpertLayersRatio,
            "load.gpuSplitConfig": convertGPUSettingToGPUSplitConfig(config.gpu),
            "llama.flashAttention": config.flashAttention,
            "llama.ropeFrequencyBase": numberToCheckboxNumeric(config.ropeFrequencyBase, 0, 0),
            "llama.ropeFrequencyScale": numberToCheckboxNumeric(config.ropeFrequencyScale, 0, 0),
            "llama.keepModelInMemory": config.keepModelInMemory,
            "seed": numberToCheckboxNumeric(config.seed, -1, 0),
            "llama.useFp16ForKVCache": config.useFp16ForKVCache,
            "llama.tryMmap": config.tryMmap,
            "numExperts": config.numExperts,
            "llama.kCacheQuantizationType": cacheQuantizationTypeToCheckbox({
                value: config.llamaKCacheQuantizationType,
                falseDefault: "f16",
            }),
            "llama.vCacheQuantizationType": cacheQuantizationTypeToCheckbox({
                value: config.llamaVCacheQuantizationType,
                falseDefault: "f16",
            }),
        });
    }
    /** @internal */
    createDomainSpecificModel(port, info, validator, logger) {
        return new LLM(port, info, validator, logger);
    }
    /** @internal */
    createDomainDynamicHandle(port, specifier, validator, logger) {
        return new LLMDynamicHandle(port, specifier, validator, logger);
    }
}

/**
 * Represents the result of a prediction from a generator plugin.
 *
 * The most notably property is {@link GeneratorPredictionResult#content}, which contains the
 * generated text.
 *
 * @public
 * @experimental [EXP-GEN-PREDICT] Using generator plugins programmatically is still in development.
 * This may change in the future without warning.
 */
class GeneratorPredictionResult {
    constructor(
    /**
     * The newly generated text as generated by the generator plugin.
     */
    content, 
    /**
     * Part of the generated text that is "reasoning" content. For example, text inside <think>
     * tags. The generator is responsible for determining what is considered reasoning content.
     */
    reasoningContent, 
    /**
     * Part of the generated text that is not "reasoning" content. For example, text outside
     * <think> tags. The generator is responsible for determining what is considered reasoning
     * content.
     */
    nonReasoningContent, 
    /**
     * The identifier of the plugin that generated this result.
     */
    pluginIdentifier) {
        this.content = content;
        this.reasoningContent = reasoningContent;
        this.nonReasoningContent = nonReasoningContent;
        this.pluginIdentifier = pluginIdentifier;
    }
}

/**
 * Represents an ongoing prediction from a generator.
 *
 * Note, this class is Promise-like, meaning you can use it as a promise. It resolves to a
 * {@link GeneratorPredictionResult}, which contains the generated text in the `.content` property. Example
 * usage:
 *
 * ```typescript
 * const result = await generator.complete("When will The Winds of Winter be released?");
 * console.log(result.content);
 * ```
 *
 * Or you can use instances methods like `then` and `catch` to handle the result or error of the
 * prediction.
 *
 * ```typescript
 * generator.complete("When will The Winds of Winter be released?")
 *  .then(result =\> console.log(result.content))
 *  .catch(error =\> console.error(error));
 * ```
 *
 * Alternatively, you can also stream the result (process the results as more content is being
 * generated). For example:
 *
 * ```typescript
 * for await (const { content } of generator.complete("When will The Winds of Winter be released?")) {
 *   process.stdout.write(content);
 * }
 * ```
 *
 * @public
 * @experimental [EXP-GEN-PREDICT] Using generator plugins programmatically is still in development.
 * This may change in the future without warning.
 */
class OngoingGeneratorPrediction extends StreamablePromise {
    async collect(fragments) {
        const content = fragments.map(({ content }) => content).join("");
        const reasoningContent = fragments
            .filter(({ isStructural }) => !isStructural)
            .filter(({ reasoningType }) => reasoningType === "reasoning")
            .map(({ content }) => content)
            .join("");
        const nonReasoningContent = fragments
            .filter(({ isStructural }) => !isStructural)
            .filter(({ reasoningType }) => reasoningType === "none")
            .map(({ content }) => content)
            .join("");
        return new GeneratorPredictionResult(content, reasoningContent, nonReasoningContent, this.pluginIdentifier);
    }
    constructor(pluginIdentifier, onCancel) {
        super();
        this.pluginIdentifier = pluginIdentifier;
        this.onCancel = onCancel;
    }
    /** @internal */
    static create(pluginIdentifier, onCancel) {
        const ongoingPrediction = new OngoingGeneratorPrediction(pluginIdentifier, onCancel);
        const finished = () => ongoingPrediction.finished();
        const failed = (error) => ongoingPrediction.finished(error);
        const push = (fragment) => ongoingPrediction.push(fragment);
        return { ongoingPrediction, finished, failed, push };
    }
    /**
     * Get the final prediction results. If you have been streaming the results, awaiting on this
     * method will take no extra effort, as the results are already available in the internal buffer.
     *
     * Example:
     *
     * ```typescript
     * const prediction = generator.complete("When will The Winds of Winter be released?");
     * for await (const { content } of prediction) {
     *   process.stdout.write(content);
     * }
     * const result = await prediction.result();
     * console.log(result.stats);
     * ```
     *
     * Technically, awaiting on this method is the same as awaiting on the instance itself:
     *
     * ```typescript
     * await prediction.result();
     *
     * // Is the same as:
     *
     * await prediction;
     * ```
     */
    async result() {
        return await this;
    }
    /**
     * Cancels the prediction.
     */
    async cancel() {
        this.onCancel();
    }
}

const llmGeneratorPredictionOptsSchema = zod.z.object({
    onFirstToken: zod.z.function().optional(),
    onPredictionFragment: zod.z.function().optional(),
    onMessage: zod.z.function().optional(),
    signal: zod.z.instanceof(AbortSignal).optional(),
    pluginConfig: kvConfigSchema.optional(),
    workingDirectory: zod.z.string().optional(),
});
const llmGeneratorActOptsSchema = llmActBaseOptsSchema.extend({
    pluginConfig: kvConfigSchema.optional(),
    workingDirectory: zod.z.string().optional(),
});
/**
 * Represents a handle for a generator that can act as a LLM.
 *
 * @public
 * @experimental [EXP-GEN-PREDICT] Using generator plugins programmatically is still in development.
 * This may change in the future without warning.
 */
class LLMGeneratorHandle {
    /**
     * Don't use this method directly, use {@link LLMNamespace#createGeneratorHandle} instead.
     *
     * @internal
     */
    constructor(
    /** @internal */
    port, 
    /** @internal */
    pluginIdentifier, 
    /** @internal */
    validator, 
    /** @internal */
    associatedPredictionProcess, 
    /** @internal */
    logger = new SimpleLogger(`LLMGeneratorHandle`)) {
        this.port = port;
        this.pluginIdentifier = pluginIdentifier;
        this.validator = validator;
        this.associatedPredictionProcess = associatedPredictionProcess;
        this.logger = logger;
        /**
         * The identifier of the plugin that this handle is associated with.
         */
        this.identifier = this.pluginIdentifier;
    }
    getPluginConfigSpecifier(userSuppliedPluginConfig, userSuppliedWorkingDirectory, stack) {
        if (this.associatedPredictionProcess === null) {
            // If there is no associated prediction process, we can use the user-supplied config directly.
            return {
                type: "direct",
                config: userSuppliedPluginConfig ?? emptyKVConfig,
                workingDirectoryPath: userSuppliedWorkingDirectory ?? undefined,
            };
        }
        // If there is an associated prediction process, we first need to make sure that the user has
        // not supplied a plugin config or working directory, as these are not allowed in this case.
        // (The plugin config/working directory of the prediction process will be used instead.)
        if (userSuppliedPluginConfig !== undefined) {
            throw makeTitledPrettyError("Cannot use plugin config with prediction process", text `
          You cannot provide a plugin config to the generator handle when it is associated with a
          prediction process. The plugin config that was configured for the prediction process will
          be used instead.

          If you want to use a different plugin config, you will need to create a separate
          GeneratorHandle instead.
        `, stack);
        }
        if (userSuppliedWorkingDirectory !== undefined) {
            throw makeTitledPrettyError("Cannot use working directory with prediction process", text `
          You cannot provide a working directory to the generator handle when it is associated with
          a prediction process. The working directory that was configured for the prediction process
          will be used instead.

          If you want to use a different working directory, you will need to create a separate
          GeneratorHandle instead.
        `, stack);
        }
        // If we reach here, we can safely return the plugin config specifier for the prediction
        // process.
        return {
            type: "predictionProcess",
            pci: this.associatedPredictionProcess.pci,
            token: this.associatedPredictionProcess.token,
        };
    }
    /**
     * Use the generator to produce a response based on the given history.
     */
    respond(chat, opts = {}) {
        const stack = getCurrentStack(1);
        [chat, opts] = this.validator.validateMethodParamsOrThrow("LLMGeneratorHandle", "respond", ["chat", "opts"], [chatHistoryLikeSchema, llmGeneratorPredictionOptsSchema], [chat, opts], stack);
        const { onFirstToken, onPredictionFragment, onMessage, signal, pluginConfig, workingDirectory, } = opts;
        let resolved = false;
        let firstTokenTriggered = false;
        const cancelEvent = new CancelEvent();
        if (signal !== undefined) {
            if (signal.aborted) {
                // If the signal is already aborted, we can immediately cancel the event.
                cancelEvent.cancel();
            }
            else {
                signal.addEventListener("abort", () => cancelEvent.cancel(), { once: true });
            }
        }
        const { ongoingPrediction, finished, failed, push } = OngoingGeneratorPrediction.create(this.pluginIdentifier, () => {
            cancelEvent.cancel();
        });
        const channel = this.port.createChannel("generateWithGenerator", {
            pluginIdentifier: this.pluginIdentifier,
            pluginConfigSpecifier: this.getPluginConfigSpecifier(pluginConfig, workingDirectory, stack),
            tools: [],
            history: accessMaybeMutableInternals(Chat.from(chat))._internalGetData(),
        }, message => {
            const messageType = message.type;
            switch (messageType) {
                case "fragment": {
                    if (!firstTokenTriggered) {
                        firstTokenTriggered = true;
                        safeCallCallback(this.logger, "onFirstToken", onFirstToken, []);
                    }
                    safeCallCallback(this.logger, "onPredictionFragment", onPredictionFragment, [
                        message.fragment,
                    ]);
                    push(message.fragment);
                    break;
                }
                case "success": {
                    resolved = true;
                    finished();
                    break;
                }
            }
        }, { stack });
        channel.onError.subscribeOnce(error => {
            if (resolved) {
                return;
            }
            resolved = true;
            failed(error);
        });
        cancelEvent.subscribeOnce(() => {
            if (resolved) {
                return;
            }
            channel.send({ type: "cancel" });
        });
        ongoingPrediction.then(result => {
            // Call the onMessage callback with the result.
            safeCallCallback(this.logger, "onMessage", onMessage, [
                ChatMessage.create("assistant", result.content),
            ]);
        }, () => { });
        return ongoingPrediction;
    }
    async act(chat, tools, opts = {}) {
        const startTime = performance.now();
        const stack = getCurrentStack(1);
        [chat, opts] = this.validator.validateMethodParamsOrThrow("LLMGeneratorHandle", "act", ["chat", "opts"], [chatHistoryLikeSchema, llmGeneratorActOptsSchema], [chat, opts], stack);
        const { pluginConfig, workingDirectory, ...baseOpts } = opts;
        const toolDefinitions = tools.map(toolToLLMTool);
        return await internalAct(chat, tools, baseOpts, stack, this.logger, startTime, 
        // Implementation of the prediction function. This performs the prediction by creating a
        // predict channel and redirect the messages to the appropriate handlers.
        async ({ allowTools, history, signal, handleFragment, handlePromptProcessingProgress, handleToolCallGenerationStart, handleToolCallGenerationNameReceived, handleToolCallGenerationArgumentFragmentGenerated, handleToolCallGenerationEnd, handleToolCallGenerationFailed, handlePredictionEnd, handleError, }) => {
            // Use predict channel
            const channel = this.port.createChannel("generateWithGenerator", {
                pluginIdentifier: this.pluginIdentifier,
                pluginConfigSpecifier: this.getPluginConfigSpecifier(pluginConfig, workingDirectory, stack),
                tools: allowTools ? toolDefinitions : [],
                history,
            }, message => {
                const messageType = message.type;
                switch (messageType) {
                    case "fragment": {
                        handleFragment(message.fragment);
                        break;
                    }
                    case "promptProcessingProgress": {
                        handlePromptProcessingProgress(message.progress);
                        break;
                    }
                    case "toolCallGenerationStart": {
                        handleToolCallGenerationStart(message.toolCallId);
                        break;
                    }
                    case "toolCallGenerationNameReceived": {
                        handleToolCallGenerationNameReceived(message.name);
                        break;
                    }
                    case "toolCallGenerationArgumentFragmentGenerated": {
                        handleToolCallGenerationArgumentFragmentGenerated(message.content);
                        break;
                    }
                    case "toolCallGenerationEnd": {
                        handleToolCallGenerationEnd(message.toolCallRequest, undefined);
                        break;
                    }
                    case "toolCallGenerationFailed": {
                        handleToolCallGenerationFailed(new Error("Tool call generation failed"), // Placeholder error for now
                        undefined);
                        break;
                    }
                    case "success": {
                        // Nothing to hand to the `makePredictionResult` function. Just pass in `undefined`.
                        handlePredictionEnd(undefined);
                        break;
                    }
                }
            }, { stack });
            if (signal.aborted) {
                // If the signal is already aborted, we can immediately cancel the channel.
                channel.send({ type: "cancel" });
            }
            else {
                signal.addEventListener("abort", () => {
                    channel.send({ type: "cancel" });
                }, { once: true });
            }
            channel.onError.subscribeOnce(handleError);
        }, ({ content, nonReasoningContent, reasoningContent }) => new GeneratorPredictionResult(content, reasoningContent, nonReasoningContent, this.pluginIdentifier));
    }
}

const generatorSchema = zod.z.function();

/**
 * The base class for all controllers.
 *
 * @public
 * @experimental [EXP-PLUGIN-CORE] Plugin support is still in development. This may change in the
 * future without warning.
 */
class BaseController {
    constructor(
    /**
     * The LM Studio client instance. Use this to interact with the LM Studio API.
     */
    client, 
    /**
     * The abort signal that you should listen to for cancellation requests.
     *
     * See https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal for more information about
     * abort signals.
     */
    abortSignal, pluginConfig, globalPluginConfig, workingDirectoryPath) {
        this.client = client;
        this.abortSignal = abortSignal;
        this.pluginConfig = pluginConfig;
        this.globalPluginConfig = globalPluginConfig;
        this.workingDirectoryPath = workingDirectoryPath;
    }
    /**
     * Gets the working directory for the current prediction. If your plugin produces files, you
     * should aim to put them in this directory.
     */
    getWorkingDirectory() {
        if (this.workingDirectoryPath === null) {
            throw new Error("This prediction process is not attached to a working directory.");
        }
        return this.workingDirectoryPath;
    }
    /**
     * Get the per-chat config for the plugin. Takes in the configSchematics. You can get the
     * values of fields like so:
     *
     * ```ts
     * const config = ctl.getPluginConfig(configSchematics);
     * const value = config.get("fieldKey");
     * ```
     *
     * @remarks
     *
     * If you need to name the type of the returned value, use:
     *
     * `InferParsedConfig<typeof configSchematics>`.
     *
     * Example:
     *
     * ```ts
     * function myFunction(config: InferParsedConfig<typeof configSchematics>) {
     *   // ...
     * }
     *
     * myFunction(ctl.getPluginConfig(configSchematics));
     * ```
     */
    getPluginConfig(configSchematics) {
        return configSchematics.parse(this.pluginConfig);
    }
    /**
     * Get the application-wide config for the plugin. Takes in the globalConfigSchematics. You can
     * get the values of fields like so:
     *
     * ```ts
     * const config = ctl.getGlobalPluginConfig(globalConfigSchematics);
     * const value = config.get("fieldKey");
     * ```
     *
     * @remarks
     *
     * If you need to name the type of the returned value, use:
     *
     * `InferParsedConfig<typeof globalConfigSchematics>`.
     *
     * Example:
     *
     * ```ts
     * function myFunction(config: InferParsedConfig<typeof globalConfigSchematics>) {
     *   // ...
     * }
     *
     * myFunction(ctl.getGlobalPluginConfig(globalConfigSchematics));
     * ```
     */
    getGlobalPluginConfig(globalConfigSchematics) {
        return globalConfigSchematics.parse(this.globalPluginConfig);
    }
    /**
     * Provides a callback that will be called when the prediction is aborted. If the prediction is
     * already aborted, the callback will be called immediately.
     *
     * You can also use {@link BaseController.abortSignal} if you are using an async function that
     * supports abort signals.
     *
     * See https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal for more information about
     * abort signals.
     */
    onAborted(callback) {
        if (this.abortSignal.aborted) {
            callback();
        }
        else {
            this.abortSignal.addEventListener("abort", callback, { once: true });
        }
    }
}

/**
 * Controller for a generator.
 *
 * @public
 * @experimental [EXP-PLUGIN-CORE] Plugin support is still in development. This may change in the
 * future without warning.
 */
class GeneratorController extends BaseController {
    /**
     * @internal Do not construct this class yourself.
     */
    constructor(client, pluginConfig, globalPluginConfig, workingDirectoryPath, abortSignal, toolDefinitions, connector, validator) {
        super(client, abortSignal, pluginConfig, globalPluginConfig, workingDirectoryPath);
        this.toolDefinitions = toolDefinitions;
        this.connector = connector;
        this.validator = validator;
    }
    /**
     * Get the definitions of the tools available for this generation.
     */
    getToolDefinitions() {
        return this.toolDefinitions;
    }
    /**
     * Use this function to report a text fragment has been generated.
     *
     * @param content - The content that has been generated.
     * @param opts - Additional info about the generated content, such as how many tokens it contains.
     *   See {@link LLMPredictionFragmentInputOpts} for more info. All the fields are optional.
     */
    fragmentGenerated(content, opts = {}) {
        const stack = getCurrentStack(1);
        [content, opts] = this.validator.validateMethodParamsOrThrow("GeneratorController", "fragmentGenerated", ["content", "opts"], [zod.z.string(), llmPredictionFragmentInputOptsSchema], [content, opts], stack);
        this.connector.fragmentGenerated(content, opts);
    }
    /**
     * Use this function to report that a tool call generation has started. Each
     * `toolCallGenerationStarted` must be paired up with a `toolCallGenerationEnded` call for
     * successfully generated tool calls, or a `toolCallGenerationFailed` call for
     * failed tool calls.
     */
    toolCallGenerationStarted({ toolCallId, } = {}) {
        this.connector.toolCallGenerationStarted(toolCallId);
    }
    /**
     * Use this function to report that the name of the tool call has been generated. This function
     * should only be called once for each `toolCallGenerationStarted`.
     *
     * @param toolName - The name of the tool that has been generated.
     */
    toolCallGenerationNameReceived(toolName) {
        const stack = getCurrentStack(1);
        toolName = this.validator.validateMethodParamOrThrow("GeneratorController", "toolCallGenerationNameReceived", "toolName", zod.z.string(), toolName, stack);
        this.connector.toolCallGenerationNameReceived(toolName);
    }
    /**
     * Use this function to report that a new argument fragment has been generated for the tool call.
     * This function can be called multiple times for each `toolCallGenerationStarted`.
     *
     * @param content - The new fragment that has been generated for the tool call.
     */
    toolCallGenerationArgumentFragmentGenerated(content) {
        const stack = getCurrentStack(1);
        content = this.validator.validateMethodParamOrThrow("GeneratorController", "toolCallGenerationArgumentFragmentGenerated", "content", zod.z.string(), content, stack);
        this.connector.toolCallGenerationArgumentFragmentGenerated(content);
    }
    /**
     * Use this function to report that a tool call generation has successfully ended. This function
     * should only be called after a `toolCallGenerationStarted` call.
     */
    toolCallGenerationEnded(toolCallRequest) {
        const stack = getCurrentStack(1);
        toolCallRequest = this.validator.validateMethodParamOrThrow("GeneratorController", "toolCallGenerationEnded", "toolCallRequest", toolCallRequestSchema, toolCallRequest, stack);
        this.connector.toolCallGenerationEnded(toolCallRequest);
    }
    /**
     * Use this function to report that a tool call generation has failed. This function should only
     * be called after a `toolCallGenerationStarted` call.
     *
     * @param error - The error that occurred during the tool call generation.
     */
    toolCallGenerationFailed(error) {
        const stack = getCurrentStack(1);
        error = this.validator.validateMethodParamOrThrow("GeneratorController", "toolCallGenerationFailed", "error", zod.z.instanceof(Error), error, stack);
        this.connector.toolCallGenerationFailed(error);
    }
}

var __addDisposableResource$1 = (globalThis && globalThis.__addDisposableResource) || function (env, value, async) {
    if (value !== null && value !== void 0) {
        if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
        var dispose, inner;
        if (async) {
            if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
            dispose = value[Symbol.asyncDispose];
        }
        if (dispose === void 0) {
            if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
            dispose = value[Symbol.dispose];
            if (async) inner = dispose;
        }
        if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
        if (inner) dispose = function() { try { inner.call(this); } catch (e) { return Promise.reject(e); } };
        env.stack.push({ value: value, dispose: dispose, async: async });
    }
    else if (async) {
        env.stack.push({ async: true });
    }
    return value;
};
var __disposeResources$1 = (globalThis && globalThis.__disposeResources) || (function (SuppressedError) {
    return function (env) {
        function fail(e) {
            env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
            env.hasError = true;
        }
        var r, s = 0;
        function next() {
            while (r = env.stack.pop()) {
                try {
                    if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
                    if (r.dispose) {
                        var result = r.dispose.call(r.value);
                        if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
                    }
                    else s |= 1;
                }
                catch (e) {
                    fail(e);
                }
            }
            if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
            if (env.hasError) throw env.error;
        }
        return next();
    };
})(typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
function stringifyAny(message) {
    switch (typeof message) {
        case "string":
            return message;
        case "number":
            return message.toString();
        case "boolean":
            return message ? "true" : "false";
        case "undefined":
            return "undefined";
        case "object":
            if (message === null) {
                return "null";
            }
            if (message instanceof Error) {
                return message.stack;
            }
            return JSON.stringify(message, null, 2);
        case "bigint":
            return message.toString();
        case "symbol":
            return message.toString();
        case "function":
            return message.toString();
        default:
            return "unknown";
    }
}
function concatenateDebugMessages(...messages) {
    return messages.map(stringifyAny).join(" ");
}
function createId() {
    return `${Date.now()}-${Math.random()}`;
}
class ProcessingConnector {
    constructor(pluginsPort, abortSignal, processingContextIdentifier, token, logger) {
        this.pluginsPort = pluginsPort;
        this.abortSignal = abortSignal;
        this.processingContextIdentifier = processingContextIdentifier;
        this.token = token;
        this.logger = logger;
    }
    handleUpdate(update) {
        this.pluginsPort
            .callRpc("processingHandleUpdate", {
            pci: this.processingContextIdentifier,
            token: this.token,
            update,
        })
            .catch(error => {
            this.logger.error("Failed to send update", error);
        });
    }
    async handleRequest(request) {
        const { response } = await this.pluginsPort.callRpc("processingHandleRequest", {
            pci: this.processingContextIdentifier,
            token: this.token,
            request,
        });
        return response;
    }
    async pullHistory(includeCurrent) {
        const chatHistoryData = await this.pluginsPort.callRpc("processingPullHistory", {
            pci: this.processingContextIdentifier,
            token: this.token,
            includeCurrent,
        });
        // We know the result of callRpc is immutable, so we can safely pass false as the second
        // argument.
        return Chat.createRaw(chatHistoryData, /* mutable */ false).asMutableCopy();
    }
    async getOrLoadTokenSource() {
        const result = await this.pluginsPort.callRpc("processingGetOrLoadTokenSource", {
            pci: this.processingContextIdentifier,
            token: this.token,
        });
        return result.tokenSourceIdentifier;
    }
    async hasStatus() {
        return await this.pluginsPort.callRpc("processingHasStatus", {
            pci: this.processingContextIdentifier,
            token: this.token,
        });
    }
    async needsNaming() {
        return await this.pluginsPort.callRpc("processingNeedsNaming", {
            pci: this.processingContextIdentifier,
            token: this.token,
        });
    }
    async suggestName(name) {
        await this.pluginsPort.callRpc("processingSuggestName", {
            pci: this.processingContextIdentifier,
            token: this.token,
            name,
        });
    }
}
/**
 * @public
 */
class ProcessingController extends BaseController {
    /** @internal */
    constructor(client, pluginConfig, globalPluginConfig, workingDirectoryPath, enabledPluginInfos, 
    /** @internal */
    connector, 
    /** @internal */
    config, 
    /**
     * When getting history, should the latest user input be included in the history?
     *
     * @internal
     */
    shouldIncludeCurrentInHistory) {
        super(client, connector.abortSignal, pluginConfig, globalPluginConfig, workingDirectoryPath);
        this.enabledPluginInfos = enabledPluginInfos;
        this.connector = connector;
        this.config = config;
        this.shouldIncludeCurrentInHistory = shouldIncludeCurrentInHistory;
        this.processingControllerHandle = {
            abortSignal: connector.abortSignal,
            sendUpdate: update => {
                connector.handleUpdate(update);
            },
            sendRequest: async (request) => {
                const type = request.type;
                const response = await connector.handleRequest(request);
                if (response.type !== type) {
                    throw new Error(`Expected response type ${type}, but got ${response.type}. This is a bug.`);
                }
                return response;
            },
        };
    }
    sendUpdate(update) {
        this.processingControllerHandle.sendUpdate(update);
    }
    /**
     * Gets a mutable copy of the current history. The returned history is a copy, so mutating it will
     * not affect the actual history. It is mutable for convenience reasons.
     *
     * - If you are a promptPreprocessor, this will not include the user message you are currently
     *   preprocessing.
     * - If you are a prediction loop handler, this will include the user message, and can be fed into
     *   the {@link LLMDynamicHandle#respond} method directly.
     */
    async pullHistory() {
        return await this.connector.pullHistory(this.shouldIncludeCurrentInHistory);
    }
    createStatus(initialState) {
        const id = createId();
        this.sendUpdate({
            type: "status.create",
            id,
            state: initialState,
        });
        const statusController = new PredictionProcessStatusController(this.processingControllerHandle, initialState, id);
        return statusController;
    }
    addCitations(arg) {
        if (Array.isArray(arg)) {
            for (const entry of arg) {
                this.createCitationBlock(entry.content, {
                    fileName: entry.source.name,
                    fileIdentifier: entry.source.identifier,
                });
            }
        }
        else {
            for (const entry of arg.entries) {
                this.createCitationBlock(entry.content, {
                    fileName: entry.source.name,
                    fileIdentifier: entry.source.identifier,
                });
            }
        }
    }
    createCitationBlock(citedText, source) {
        const id = createId();
        this.sendUpdate({
            type: "citationBlock.create",
            id,
            citedText,
            ...source,
        });
        const citationBlockController = new PredictionProcessCitationBlockController(this.processingControllerHandle, id);
        return citationBlockController;
    }
    /**
     * @internal
     */
    createDebugInfoBlock(debugInfo) {
        const id = createId();
        this.sendUpdate({
            type: "debugInfoBlock.create",
            id,
            debugInfo,
        });
        const debugInfoBlockController = new PredictionProcessDebugInfoBlockController(this.processingControllerHandle, id);
        return debugInfoBlockController;
    }
    createContentBlock({ roleOverride, includeInContext = true, style, prefix, suffix, } = {}) {
        const id = createId();
        this.sendUpdate({
            type: "contentBlock.create",
            id,
            roleOverride,
            includeInContext,
            style,
            prefix,
            suffix,
        });
        const contentBlockController = new PredictionProcessContentBlockController(this.processingControllerHandle, id, roleOverride ?? "assistant");
        return contentBlockController;
    }
    debug(...messages) {
        this.createDebugInfoBlock(concatenateDebugMessages(...messages));
    }
    /**
     * Gets the token source associated with this prediction process (i.e. what the user has selected
     * on the top navigation bar).
     *
     * The token source can either be a model or a generator plugin. In both cases, the returned
     * object will contain a ".act" and a ".respond" method, which can be used to generate text.
     *
     * The token source is already pre-configured to use user's prediction config - you don't need to
     * pass through any additional configuration.
     */
    async tokenSource() {
        const tokenSourceIdentifier = await this.connector.getOrLoadTokenSource();
        const tokenSourceIdentifierType = tokenSourceIdentifier.type;
        switch (tokenSourceIdentifierType) {
            case "model": {
                const model = await this.client.llm.model(tokenSourceIdentifier.identifier);
                // Don't use the server session config for this model
                model.internalIgnoreServerSessionConfig = true;
                // Inject the prediction config
                model.internalKVConfigStack = {
                    layers: [
                        {
                            layerName: "conversationSpecific",
                            config: this.config,
                        },
                    ],
                };
                return model;
            }
            case "generator": {
                const generator = this.client.plugins.createGeneratorHandleAssociatedWithPredictionProcess(tokenSourceIdentifier.pluginIdentifier, this.connector.processingContextIdentifier, this.connector.token);
                return generator;
            }
        }
    }
    /**
     * Sets the sender name for this message. The sender name shown above the message in the chat.
     */
    async setSenderName(name) {
        this.sendUpdate({
            type: "setSenderName",
            name,
        });
    }
    /**
     * Throws an error if the prediction process has been aborted. Sprinkle this throughout your code
     * to ensure that the prediction process is aborted as soon as possible.
     */
    guardAbort() {
        this.abortSignal.throwIfAborted();
    }
    /**
     * Whether this prediction process has had any status.
     */
    async hasStatus() {
        return await this.connector.hasStatus();
    }
    /**
     * Returns whether this conversation needs a name.
     */
    async needsNaming() {
        return await this.connector.needsNaming();
    }
    /**
     * Suggests a name for this conversation.
     */
    async suggestName(name) {
        await this.connector.suggestName(name);
    }
    async requestConfirmToolCall({ callId, pluginIdentifier, name, parameters, }) {
        const { result } = await raceWithAbortSignal(this.processingControllerHandle.sendRequest({
            type: "confirmToolCall",
            callId,
            pluginIdentifier,
            name,
            parameters,
        }), this.abortSignal);
        const resultType = result.type;
        switch (resultType) {
            case "allow": {
                return {
                    type: "allow",
                    toolArgsOverride: result.toolArgsOverride,
                };
            }
            case "deny": {
                return {
                    type: "deny",
                    denyReason: result.denyReason,
                };
            }
            default: {
                const exhaustiveCheck = resultType;
                throw new Error(`Unexpected result type ${exhaustiveCheck}. This is a bug. Please report it.`);
            }
        }
    }
    createToolStatus(callId, initialStatus) {
        const id = createId();
        this.sendUpdate({
            type: "toolStatus.create",
            id,
            callId,
            state: {
                status: initialStatus,
                customStatus: "",
                customWarnings: [],
            },
        });
        const toolStatusController = new PredictionProcessToolStatusController(this.processingControllerHandle, id, initialStatus);
        return toolStatusController;
    }
    /**
     * Starts a tool use session with tools available in the prediction process. Note, this method
     * should be used with "Explicit Resource Management". That is, you should use it like so:
     *
     * ```typescript
     * using toolUseSession = await ctl.startToolUseSession();
     * // ^ Notice the `using` keyword here.
     * ```
     *
     * If you do not `using`, you should call `toolUseSession[Symbol.dispose]()` after you are done.
     *
     * If you don't, lmstudio-js will close the session upon the end of the prediction step
     * automatically. However, it is not recommended.
     *
     * @public
     * @deprecated WIP
     */
    async startToolUseSession() {
        const identifiersOfPluginsWithTools = this.enabledPluginInfos
            .filter(({ hasToolsProvider }) => hasToolsProvider)
            .map(({ identifier }) => identifier);
        return await this.client.plugins.startToolUseSessionUsingPredictionProcess(
        // We start a tool use session with all the plugins that have tools available
        identifiersOfPluginsWithTools, this.connector.processingContextIdentifier, this.connector.token);
    }
}
/**
 * Controller for a status block in the prediction process.
 *
 * @public
 */
class PredictionProcessStatusController {
    /** @internal */
    constructor(
    /** @internal */
    handle, initialState, id, indentation = 0) {
        this.handle = handle;
        this.id = id;
        this.indentation = indentation;
        this.lastSubStatus = this;
        this.lastState = initialState;
    }
    setText(text) {
        this.lastState.text = text;
        this.handle.sendUpdate({
            type: "status.update",
            id: this.id,
            state: this.lastState,
        });
    }
    setState(state) {
        this.lastState = state;
        this.handle.sendUpdate({
            type: "status.update",
            id: this.id,
            state,
        });
    }
    remove() {
        this.handle.sendUpdate({
            type: "status.remove",
            id: this.id,
        });
    }
    getNestedLastSubStatusBlockId() {
        let current = this.lastSubStatus;
        while (current !== current.lastSubStatus) {
            current = current.lastSubStatus;
        }
        return current.id;
    }
    addSubStatus(initialState) {
        const id = createId();
        this.handle.sendUpdate({
            type: "status.create",
            id,
            state: initialState,
            location: {
                type: "afterId",
                id: this.getNestedLastSubStatusBlockId(),
            },
            indentation: this.indentation + 1,
        });
        const controller = new PredictionProcessStatusController(this.handle, initialState, id, this.indentation + 1);
        this.lastSubStatus = controller;
        return controller;
    }
}
/**
 * Controller for a citation block in the prediction process. Currently cannot do anything.
 *
 * @public
 */
class PredictionProcessCitationBlockController {
    /** @internal */
    constructor(
    /** @internal */
    handle, id) {
        this.handle = handle;
        this.id = id;
    }
}
/**
 * Controller for a debug info block in the prediction process. Currently cannot do anything.
 *
 * @public
 */
class PredictionProcessDebugInfoBlockController {
    /** @internal */
    constructor(
    /** @internal */
    handle, id) {
        this.handle = handle;
        this.id = id;
    }
}
/**
 * @public
 *
 * TODO: Documentation
 */
class PredictionProcessContentBlockController {
    /** @internal */
    constructor(
    /** @internal */
    handle, id, role) {
        this.handle = handle;
        this.id = id;
        this.role = role;
    }
    appendText(text, { tokensCount, fromDraftModel, isStructural } = {}) {
        if (this.role === "tool") {
            throw new Error("Text cannot be appended to tool blocks.");
        }
        this.handle.sendUpdate({
            type: "contentBlock.appendText",
            id: this.id,
            text,
            tokensCount,
            fromDraftModel,
            isStructural,
        });
    }
    appendToolRequest({ callId, toolCallRequestId, name, parameters, pluginIdentifier, }) {
        if (this.role !== "assistant") {
            throw new Error(`Tool requests can only be appended to assistant blocks. This is a ${this.role} block.`);
        }
        this.handle.sendUpdate({
            type: "contentBlock.appendToolRequest",
            id: this.id,
            callId,
            toolCallRequestId,
            name,
            parameters,
            pluginIdentifier,
        });
    }
    replaceToolRequest({ callId, toolCallRequestId, name, parameters, pluginIdentifier, }) {
        if (this.role !== "assistant") {
            throw new Error(`Tool requests can only be replaced in assistant blocks. This is a ${this.role} block.`);
        }
        this.handle.sendUpdate({
            type: "contentBlock.replaceToolRequest",
            id: this.id,
            callId,
            toolCallRequestId,
            name,
            parameters,
            pluginIdentifier,
        });
    }
    appendToolResult({ callId, toolCallRequestId, content, }) {
        if (this.role !== "tool") {
            throw new Error(`Tool results can only be appended to tool blocks. This is a ${this.role} block.`);
        }
        this.handle.sendUpdate({
            type: "contentBlock.appendToolResult",
            id: this.id,
            callId,
            toolCallRequestId,
            content,
        });
    }
    replaceText(text) {
        if (this.role === "tool") {
            throw new Error("Text cannot be set in tool blocks.");
        }
        this.handle.sendUpdate({
            type: "contentBlock.replaceText",
            id: this.id,
            text,
        });
    }
    setStyle(style) {
        this.handle.sendUpdate({
            type: "contentBlock.setStyle",
            id: this.id,
            style,
        });
    }
    setPrefix(prefix) {
        this.handle.sendUpdate({
            type: "contentBlock.setPrefix",
            id: this.id,
            prefix,
        });
    }
    setSuffix(suffix) {
        this.handle.sendUpdate({
            type: "contentBlock.setSuffix",
            id: this.id,
            suffix,
        });
    }
    attachGenInfo(genInfo) {
        this.handle.sendUpdate({
            type: "contentBlock.attachGenInfo",
            id: this.id,
            genInfo,
        });
    }
    async pipeFrom(prediction) {
        const env_1 = { stack: [], error: void 0, hasError: false };
        try {
            const cleaner = __addDisposableResource$1(env_1, new Cleaner(), false);
            const abortListener = () => {
                prediction.cancel();
            };
            this.handle.abortSignal.addEventListener("abort", abortListener);
            cleaner.register(() => {
                this.handle.abortSignal.removeEventListener("abort", abortListener);
            });
            for await (const { content } of prediction) {
                this.appendText(content);
            }
            const result = await prediction;
            this.attachGenInfo({
                indexedModelIdentifier: result.modelInfo.path,
                identifier: result.modelInfo.identifier,
                loadModelConfig: result.loadConfig,
                predictionConfig: result.predictionConfig,
                stats: result.stats,
            });
            this.handle.abortSignal.throwIfAborted();
            return result;
        }
        catch (e_1) {
            env_1.error = e_1;
            env_1.hasError = true;
        }
        finally {
            __disposeResources$1(env_1);
        }
    }
}
/**
 * Controller for a tool status block in the prediction process.
 *
 * @public
 */
class PredictionProcessToolStatusController {
    /** @internal */
    constructor(
    /** @internal */
    handle, id, initialStatus) {
        this.handle = handle;
        this.id = id;
        this.customStatus = "";
        this.customWarnings = [];
        this.status = initialStatus;
    }
    updateState() {
        this.handle.sendUpdate({
            type: "toolStatus.update",
            id: this.id,
            state: {
                status: this.status,
                customStatus: this.customStatus,
                customWarnings: this.customWarnings,
            },
        });
    }
    setCustomStatusText(status) {
        this.customStatus = status;
        this.updateState();
    }
    addWarning(warning) {
        this.customWarnings.push(warning);
        this.updateState();
    }
    setStatus(status) {
        this.status = status;
        this.updateState();
    }
    appendArgumentFragment(content) {
        this.handle.sendUpdate({
            type: "toolStatus.argumentFragment",
            id: this.id,
            content,
        });
    }
}

/**
 * Controller for tools provider.
 *
 * @public
 * @experimental [EXP-PLUGIN-CORE] Plugin support is still in development. This may change in the
 * future without warning.
 */
class ToolsProviderController extends BaseController {
    /**
     * @internal Do not construct this class yourself.
     */
    constructor(client, signal, pluginConfig, globalPluginConfig, workingDirectoryPath) {
        super(client, signal, pluginConfig, globalPluginConfig, workingDirectoryPath);
    }
}

class GeneratorConnectorImpl {
    constructor(channel, taskId) {
        this.channel = channel;
        this.taskId = taskId;
    }
    fragmentGenerated(content, opts) {
        this.channel.send({
            type: "fragmentGenerated",
            taskId: this.taskId,
            content,
            opts: opts,
        });
    }
    toolCallGenerationStarted(toolCallId) {
        this.channel.send({
            type: "toolCallGenerationStarted",
            taskId: this.taskId,
            toolCallId,
        });
    }
    toolCallGenerationNameReceived(toolName) {
        this.channel.send({
            type: "toolCallGenerationNameReceived",
            taskId: this.taskId,
            toolName,
        });
    }
    toolCallGenerationArgumentFragmentGenerated(content) {
        this.channel.send({
            type: "toolCallGenerationArgumentFragmentGenerated",
            taskId: this.taskId,
            content,
        });
    }
    toolCallGenerationEnded(toolCallRequest) {
        this.channel.send({
            type: "toolCallGenerationEnded",
            taskId: this.taskId,
            toolCallRequest,
        });
    }
    toolCallGenerationFailed(error) {
        this.channel.send({
            type: "toolCallGenerationFailed",
            taskId: this.taskId,
            error: serializeError(error),
        });
    }
}
/**
 * @deprecated This class is used internally by a plugin to register hooks. Do not use directly.
 * @public
 */
class PluginSelfRegistrationHost {
    constructor(port, client, rootLogger, validator) {
        this.port = port;
        this.client = client;
        this.rootLogger = rootLogger;
        this.validator = validator;
    }
    /**
     * Sets the promptPreprocessor to be used by the plugin represented by this client.
     *
     * @experimental [EXP-PLUGIN-CORE] Plugin support is still in development. This may change in the
     * future without warning.
     */
    setPromptPreprocessor(promptPreprocessor) {
        const stack = getCurrentStack(1);
        this.validator.validateMethodParamOrThrow("plugins", "registerPromptPreprocessor", "promptPreprocessor", zod.z.function(), promptPreprocessor, stack);
        const logger = new SimpleLogger(`PromptPreprocessor`, this.rootLogger);
        logger.info("Register with LM Studio");
        const tasks = new Map();
        const channel = this.port.createChannel("setPromptPreprocessor", undefined, message => {
            switch (message.type) {
                case "preprocess": {
                    const taskLogger = new SimpleLogger(`Request (${message.taskId.substring(0, 6)})`, logger);
                    taskLogger.info(`New preprocess request received.`);
                    const abortController = new AbortController();
                    const connector = new ProcessingConnector(this.port, abortController.signal, message.pci, message.token, taskLogger);
                    const input = ChatMessage.createRaw(message.input, /* mutable */ false);
                    const controller = new ProcessingController(this.client, message.pluginConfig, message.globalPluginConfig, message.workingDirectoryPath, message.enabledPluginInfos, connector, message.config, 
                    /* shouldIncludeInputInHistory */ false);
                    tasks.set(message.taskId, {
                        cancel: () => {
                            abortController.abort();
                        },
                        taskLogger,
                    });
                    // We know the input from the channel is immutable, so we can safely pass false as the
                    // second argument.
                    promptPreprocessor(controller, input.asMutableCopy())
                        .then(result => {
                        taskLogger.info(`Preprocess request completed.`);
                        const parsedReturned = zod.z
                            .union([zod.z.string(), zod.z.custom(v => v instanceof ChatMessage)])
                            .safeParse(result);
                        if (!parsedReturned.success) {
                            throw new Error("PromptPreprocessor returned an invalid value:" +
                                Validator.prettyPrintZod("result", parsedReturned.error));
                        }
                        const returned = parsedReturned.data;
                        let processed;
                        if (typeof returned === "string") {
                            const messageCopy = input.asMutableCopy();
                            messageCopy.replaceText(returned);
                            processed = messageCopy.getRaw();
                        }
                        else {
                            processed = returned.getRaw();
                        }
                        channel.send({
                            type: "complete",
                            taskId: message.taskId,
                            processed,
                        });
                    })
                        .catch(error => {
                        if (error.name === "AbortError") {
                            logger.info(`Request successfully aborted.`);
                            channel.send({
                                type: "aborted",
                                taskId: message.taskId,
                            });
                            return;
                        }
                        logger.warn(`Preprocessing failed.`, error);
                        channel.send({
                            type: "error",
                            taskId: message.taskId,
                            error: serializeError(error),
                        });
                    })
                        .finally(() => {
                        tasks.delete(message.taskId);
                    });
                    break;
                }
                case "abort": {
                    const task = tasks.get(message.taskId);
                    if (task !== undefined) {
                        task.taskLogger.info(`Received abort request.`);
                        task.cancel();
                        tasks.delete(message.taskId);
                    }
                    break;
                }
            }
        }, { stack });
    }
    /**
     * Sets the prediction loop handler to be used by the plugin represented by this client.
     *
     * @deprecated [DEP-PLUGIN-PREDICTION-LOOP-HANDLER] Prediction loop handler support is still in
     * development. Stay tuned for updates.
     */
    setPredictionLoopHandler(predictionLoopHandler) {
        const stack = getCurrentStack(1);
        this.validator.validateMethodParamOrThrow("plugins", "setPredictionLoopHandler", "predictionLoopHandler", zod.z.function(), predictionLoopHandler, stack);
        const logger = new SimpleLogger(`   PredictionLoopHandler`, this.rootLogger);
        logger.info("Register with LM Studio");
        const tasks = new Map();
        const channel = this.port.createChannel("setPredictionLoopHandler", undefined, message => {
            switch (message.type) {
                case "handlePredictionLoop": {
                    const taskLogger = new SimpleLogger(`Request (${message.taskId.substring(0, 6)})`, logger);
                    taskLogger.info(`New prediction loop handling request received.`);
                    const abortController = new AbortController();
                    const connector = new ProcessingConnector(this.port, abortController.signal, message.pci, message.token, taskLogger);
                    const controller = new ProcessingController(this.client, message.pluginConfig, message.globalPluginConfig, message.workingDirectoryPath, message.enabledPluginInfos, connector, message.config, 
                    /* shouldIncludeInputInHistory */ true);
                    tasks.set(message.taskId, {
                        cancel: () => {
                            abortController.abort();
                        },
                        taskLogger,
                    });
                    // We know the input from the channel is immutable, so we can safely pass false as the
                    // second argument.
                    predictionLoopHandler(controller)
                        .then(() => {
                        channel.send({
                            type: "complete",
                            taskId: message.taskId,
                        });
                    })
                        .catch(error => {
                        if (error.name === "AbortError") {
                            logger.info(`Request successfully aborted.`);
                            channel.send({
                                type: "aborted",
                                taskId: message.taskId,
                            });
                            return;
                        }
                        logger.warn(`Generation failed.`, error);
                        channel.send({
                            type: "error",
                            taskId: message.taskId,
                            error: serializeError(error),
                        });
                    })
                        .finally(() => {
                        tasks.delete(message.taskId);
                    });
                    break;
                }
                case "abort": {
                    const task = tasks.get(message.taskId);
                    if (task !== undefined) {
                        task.taskLogger.info(`Received abort request.`);
                        task.cancel();
                        tasks.delete(message.taskId);
                    }
                    break;
                }
            }
        }, { stack });
    }
    /**
     * @experimental [EXP-PLUGIN-CORE] Plugin support is still in development. This may change in the
     * future without warning.
     */
    async setConfigSchematics(configSchematics) {
        const stack = getCurrentStack(1);
        this.validator.validateMethodParamOrThrow("plugins", "setConfigSchematics", "configSchematics", zod.z.instanceof(KVConfigSchematics), configSchematics, stack);
        await this.port.callRpc("setConfigSchematics", {
            schematics: configSchematics.serialize(),
        }, { stack });
    }
    /**
     * @experimental [EXP-PLUGIN-CORE] Plugin support is still in development. This may change in the
     * future without warning.
     */
    async setGlobalConfigSchematics(globalConfigSchematics) {
        const stack = getCurrentStack(1);
        this.validator.validateMethodParamOrThrow("plugins", "setGlobalConfigSchematics", "globalConfigSchematics", zod.z.instanceof(KVConfigSchematics), globalConfigSchematics, stack);
        await this.port.callRpc("setGlobalConfigSchematics", {
            schematics: globalConfigSchematics.serialize(),
        }, { stack });
    }
    /**
     * @experimental [EXP-PLUGIN-CORE] Plugin support is still in development. This may change in the
     * future without warning.
     */
    setToolsProvider(toolsProvider) {
        const stack = getCurrentStack(1);
        this.validator.validateMethodParamOrThrow("plugins", "setToolsProvider", "toolsProvider", zod.z.function(), toolsProvider, stack);
        const logger = new SimpleLogger(`Tools Prvdr.`, this.rootLogger);
        logger.info("Register with LM Studio");
        /**
         * Map from sessionId to the open session.
         */
        const openSessions = new Map();
        const channel = this.port.createChannel("setToolsProvider", undefined, message => {
            const messageType = message.type;
            switch (messageType) {
                case "initSession": {
                    const sessionId = message.sessionId;
                    const sessionAbortController = new AbortController();
                    const openSession = {
                        tools: null,
                        ongoingToolCalls: new Map(),
                        discarded: false,
                        abortController: sessionAbortController,
                    };
                    openSessions.set(sessionId, openSession);
                    const controller = new ToolsProviderController(this.client, sessionAbortController.signal, message.pluginConfig, message.globalPluginConfig, message.workingDirectoryPath);
                    toolsProvider(controller).then(tools => {
                        const llmTools = tools.map(toolToLLMTool);
                        if (openSession.discarded) {
                            // By the time initialization is done, the session was already discarded. Don't
                            // do anything.
                            return;
                        }
                        channel.send({
                            type: "sessionInitialized",
                            sessionId,
                            toolDefinitions: llmTools,
                        });
                        openSession.tools = new Map(tools.map(tool => [tool.name, tool]));
                    }, error => {
                        if (openSession.discarded) {
                            // If the session was already discarded, don't do anything.
                            return;
                        }
                        channel.send({
                            type: "sessionInitializationFailed",
                            sessionId,
                            error: serializeError(error),
                        });
                        openSession.discarded = true;
                        openSessions.delete(sessionId);
                    });
                    break;
                }
                case "discardSession": {
                    const sessionId = message.sessionId;
                    const openSession = openSessions.get(sessionId);
                    if (openSession === undefined) {
                        // Session was already discarded or doesn't exist. Ignore.
                        return;
                    }
                    openSession.discarded = true;
                    openSession.abortController.abort();
                    openSessions.delete(sessionId);
                    break;
                }
                case "callTool": {
                    const sessionId = message.sessionId;
                    const openSession = openSessions.get(sessionId);
                    if (openSession === undefined) {
                        // Session was already discarded or doesn't exist. Ignore.
                        return;
                    }
                    if (openSession.tools === null) {
                        throw new Error("Tool called before initialization completed. This is unexpected.");
                    }
                    const tool = openSession.tools.get(message.toolName);
                    if (tool === undefined) {
                        throw new Error(`Tool ${message.toolName} not found.`);
                    }
                    const callId = message.callId;
                    const ongoingToolCall = {
                        settled: false,
                        abortController: new AbortController(),
                    };
                    openSession.ongoingToolCalls.set(callId, ongoingToolCall);
                    new SimpleLogger(`Tool (${message.toolName})`, this.rootLogger);
                    const toolCallContext = {
                        status(text) {
                            channel.send({
                                type: "toolCallStatus",
                                sessionId,
                                callId,
                                statusText: text,
                            });
                        },
                        warn(text) {
                            channel.send({
                                type: "toolCallWarn",
                                sessionId,
                                callId,
                                warnText: text,
                            });
                        },
                        signal: ongoingToolCall.abortController.signal,
                        // Call ID is used to match up life cycle events of the same tool call. In this case,
                        // each call does not have different parts, thus call ID is useless. We can just use 0.
                        // If the user wants a "unique" ID, they can just have variable that goes up by one
                        // each time the function is called.
                        callId: 0,
                    };
                    (async () => {
                        return await tool.implementation(message.parameters, toolCallContext);
                    })().then(result => {
                        if (openSession.discarded) {
                            // Session was already discarded. Ignore.
                            return;
                        }
                        if (ongoingToolCall.settled) {
                            // Tool call was already settled. Ignore.
                            return;
                        }
                        if (ongoingToolCall.abortController.signal.aborted) {
                            // Tool call was aborted. Ignore.
                            return;
                        }
                        if (result === undefined) {
                            result = "undefined"; // Default to "undefined" if no result is provided.
                            channel.send({
                                type: "toolCallWarn",
                                sessionId,
                                callId,
                                warnText: text `
                    Tool call returned undefined. This is not expected as the model always expects
                    a result. If you don't want to return anything, you can just return a string
                    reporting that the tool call was successful. For example: "operation
                    successful." In this case, we will give the model string "${result}".
                  `,
                            });
                        }
                        // Try to see if the result is JSON serializable. If it is not, we will print a
                        // warning.
                        try {
                            JSON.stringify(result);
                        }
                        catch (error) {
                            result = text `
                  Error: Tool call completed but returned a value that cannot be serialized to JSON
                `;
                            channel.send({
                                type: "toolCallWarn",
                                sessionId,
                                callId,
                                warnText: text `
                    Tool call succeeded, but returned a value that is not JSON serializable. In
                    order to provide the result to the model, return values of tools must be JSON
                    serializable. In this case, we will give the model string "${result}".
                  `,
                            });
                        }
                        channel.send({
                            type: "toolCallComplete",
                            sessionId,
                            callId,
                            result,
                        });
                        ongoingToolCall.settled = true;
                        openSession.ongoingToolCalls.delete(callId);
                    }, error => {
                        if (openSession.discarded) {
                            // Session was already discarded. Ignore.
                            return;
                        }
                        if (ongoingToolCall.settled) {
                            // Tool call was already settled. Ignore.
                            return;
                        }
                        if (ongoingToolCall.abortController.signal.aborted) {
                            // Tool call was aborted. Ignore.
                            return;
                        }
                        channel.send({
                            type: "toolCallError",
                            sessionId,
                            callId,
                            error: serializeError(error),
                        });
                        ongoingToolCall.settled = true;
                        openSession.ongoingToolCalls.delete(callId);
                    });
                    break;
                }
                case "abortToolCall": {
                    const sessionId = message.sessionId;
                    const callId = message.callId;
                    const openSession = openSessions.get(sessionId);
                    if (openSession === undefined) {
                        // Session was already discarded or doesn't exist. Ignore.
                        return;
                    }
                    const ongoingToolCall = openSession.ongoingToolCalls.get(callId);
                    if (ongoingToolCall === undefined) {
                        // Tool call was already completed or doesn't exist. Ignore.
                        return;
                    }
                    ongoingToolCall.settled = true;
                    ongoingToolCall.abortController.abort();
                    openSession.ongoingToolCalls.delete(callId);
                    break;
                }
                default: {
                    const exhaustiveCheck = messageType;
                    throw new Error(`Unexpected message type: ${exhaustiveCheck}`);
                }
            }
        });
    }
    /**
     * Sets the generator to be used by the plugin represented by this client.
     *
     * @experimental [EXP-PLUGIN-CORE] Plugin support is still in development. This may change in the
     * future without warning.
     */
    setGenerator(generator) {
        const stack = getCurrentStack(1);
        this.validator.validateMethodParamOrThrow("plugins", "setGenerator", "generator", generatorSchema, generator, stack);
        const logger = new SimpleLogger(`Generator`, this.rootLogger);
        logger.info("Register with LM Studio");
        const tasks = new Map();
        const channel = this.port.createChannel("setGenerator", undefined, message => {
            const messageType = message.type;
            switch (messageType) {
                case "generate": {
                    const taskLogger = new SimpleLogger(`Request (${message.taskId.substring(0, 6)})`, logger);
                    taskLogger.info(`New generate request received.`);
                    const abortController = new AbortController();
                    const connector = new GeneratorConnectorImpl(channel, message.taskId);
                    const controller = new GeneratorController(this.client, message.pluginConfig, message.globalPluginConfig, message.workingDirectoryPath, abortController.signal, message.toolDefinitions, connector, this.validator);
                    tasks.set(message.taskId, {
                        cancel: () => {
                            abortController.abort();
                        },
                        taskLogger,
                    });
                    const history = Chat.createRaw(message.input, false);
                    generator(controller, history)
                        .then(result => {
                        if (result !== undefined) {
                            taskLogger.warnText `
                    The generator has returned a value. This it not expected. You should report
                    generated content using method on the controller. The returned value will be
                    ignored.
                  `;
                        }
                        channel.send({
                            type: "complete",
                            taskId: message.taskId,
                        });
                    }, error => {
                        if (error.name === "AbortError") {
                            taskLogger.info(`Request successfully aborted.`);
                            channel.send({
                                type: "aborted",
                                taskId: message.taskId,
                            });
                        }
                        else {
                            channel.send({
                                type: "error",
                                taskId: message.taskId,
                                error: serializeError(error),
                            });
                            taskLogger.warn(`Generation failed.`, error);
                        }
                    })
                        .finally(() => {
                        tasks.delete(message.taskId);
                    });
                    break;
                }
                case "abort": {
                    const task = tasks.get(message.taskId);
                    if (task !== undefined) {
                        task.taskLogger.info(`Received abort request.`);
                        task.cancel();
                        tasks.delete(message.taskId);
                    }
                    break;
                }
                default: {
                    const exhaustiveCheck = messageType;
                    throw new Error(`Unexpected message type: ${exhaustiveCheck}`);
                }
            }
        });
    }
    /**
     * @experimental [EXP-PLUGIN-CORE] Plugin support is still in development. This may change in the
     * future without warning.
     */
    async initCompleted() {
        const stack = getCurrentStack(1);
        await this.port.callRpc("pluginInitCompleted", undefined, { stack });
    }
}

var __addDisposableResource = (globalThis && globalThis.__addDisposableResource) || function (env, value, async) {
    if (value !== null && value !== void 0) {
        if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
        var dispose, inner;
        if (async) {
            if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
            dispose = value[Symbol.asyncDispose];
        }
        if (dispose === void 0) {
            if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
            dispose = value[Symbol.dispose];
            if (async) inner = dispose;
        }
        if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
        if (inner) dispose = function() { try { inner.call(this); } catch (e) { return Promise.reject(e); } };
        env.stack.push({ value: value, dispose: dispose, async: async });
    }
    else if (async) {
        env.stack.push({ async: true });
    }
    return value;
};
var __disposeResources = (globalThis && globalThis.__disposeResources) || (function (SuppressedError) {
    return function (env) {
        function fail(e) {
            env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
            env.hasError = true;
        }
        var r, s = 0;
        function next() {
            while (r = env.stack.pop()) {
                try {
                    if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
                    if (r.dispose) {
                        var result = r.dispose.call(r.value);
                        if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
                    }
                    else s |= 1;
                }
                catch (e) {
                    fail(e);
                }
            }
            if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
            if (env.hasError) throw env.error;
        }
        return next();
    };
})(typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
/**
 * Represents a tool use session backed by a single plugin. Don't construct this class yourself.
 *
 * @public
 */
class SingleRemoteToolUseSession {
    static async create(pluginsPort, pluginIdentifier, pluginConfigSpecifier, logger, stack) {
        const session = new SingleRemoteToolUseSession(pluginsPort, pluginIdentifier, pluginConfigSpecifier, logger);
        await session.init(stack);
        return session;
    }
    constructor(pluginsPort, pluginIdentifier, pluginConfigSpecifier, logger) {
        this.pluginsPort = pluginsPort;
        this.pluginIdentifier = pluginIdentifier;
        this.pluginConfigSpecifier = pluginConfigSpecifier;
        this.logger = logger;
        this.status = "initializing";
        /**
         * Whether this session is "poisoned". A session is poisoned either when the underlying channel
         * has errored/closed.
         */
        this.poison = null;
        /**
         * Map to track all the ongoing tool calls.
         */
        this.ongoingToolCalls = new Map();
        this.callIdGiver = new IdGiver(0);
    }
    async init(stack) {
        const { promise: initPromise, resolve: resolveInit, reject: rejectInit } = makePromise();
        const channel = this.pluginsPort.createChannel("startToolUseSession", {
            pluginIdentifier: this.pluginIdentifier,
            pluginConfigSpecifier: this.pluginConfigSpecifier,
        }, message => {
            const messageType = message.type;
            switch (messageType) {
                // Upon receiving session ready, mark self as ready and resolve the promise.
                case "sessionReady": {
                    if (this.status !== "initializing") {
                        this.logger.error("Received sessionReady message while not initializing");
                        return;
                    }
                    this.status = "ready";
                    resolveInit();
                    this.tools = message.toolDefinitions.map(toolDefinition => this.makeTool(toolDefinition));
                    break;
                }
                case "toolCallComplete": {
                    const ongoingCall = this.ongoingToolCalls.get(message.callId);
                    if (ongoingCall === undefined) {
                        return;
                    }
                    ongoingCall.resolve(message.result);
                    break;
                }
                case "toolCallError": {
                    const ongoingCall = this.ongoingToolCalls.get(message.callId);
                    if (ongoingCall === undefined) {
                        return;
                    }
                    ongoingCall.reject(fromSerializedError(message.error));
                    break;
                }
                case "toolCallStatus": {
                    const ongoingCall = this.ongoingToolCalls.get(message.callId);
                    if (ongoingCall === undefined) {
                        return;
                    }
                    ongoingCall.reportStatus(message.statusText);
                    break;
                }
                case "toolCallWarn": {
                    const ongoingCall = this.ongoingToolCalls.get(message.callId);
                    if (ongoingCall === undefined) {
                        return;
                    }
                    ongoingCall.reportWarning(message.warnText);
                    break;
                }
                default: {
                    const exhaustiveCheck = messageType;
                    this.logger.warn(`Received unexpected message type in tool use session: ${exhaustiveCheck}`);
                }
            }
        }, { stack });
        channel.onError.subscribeOnce(error => {
            if (this.status === "initializing") {
                // If still initializing, reject the promise with the error.
                rejectInit(error);
            }
            else {
                this.logger.error("Tool use session error.", error);
                this.poison = error;
            }
            // Reject all ongoing tool calls with the error.
            for (const ongoingCall of this.ongoingToolCalls.values()) {
                ongoingCall.reject(error);
            }
            this.status = "disposed";
        });
        channel.onClose.subscribeOnce(() => {
            let error;
            if (this.status === "initializing") {
                // If still initializing, reject the promise with the error.
                error = new Error("Tool use session channel closed unexpectedly during initialization.");
                rejectInit(error);
            }
            else {
                error = new Error("Tool use session has already ended.");
                // We don't print an error here because channel can close normally. We only poison this
                // session so it throws the error when used.
                this.poison = error;
            }
            // Reject all ongoing tool calls with the error.
            for (const ongoingCall of this.ongoingToolCalls.values()) {
                ongoingCall.reject(error);
            }
            this.status = "disposed";
        });
        this.channel = channel;
        await initPromise;
    }
    [Symbol.dispose]() {
        // As long as we are not already disposed, we send a discard message to the channel.
        if (this.status !== "disposed") {
            this.channel.send({ type: "discardSession" });
            this.status = "disposed";
            const error = new Error("Session disposed by client.");
            // Reject all ongoing tool calls with the error.
            for (const ongoingCall of this.ongoingToolCalls.values()) {
                ongoingCall.reject(error);
            }
            this.poison = error;
        }
    }
    makeTool(toolDefinition) {
        return internalCreateRemoteTool({
            name: toolDefinition.function.name,
            description: toolDefinition.function.description ?? "",
            pluginIdentifier: this.pluginIdentifier,
            parametersJsonSchema: toolDefinition.function.parameters ?? {},
            implementation: async (args, ctx) => {
                const env_1 = { stack: [], error: void 0, hasError: false };
                try {
                    // We now need to provide an implementation that basically proxies the execution of the tool
                    // to the backend.
                    if (this.poison !== null) {
                        // If the session is already poisoned, throw the error.
                        throw this.poison;
                    }
                    // Handling the case where the request is already aborted before we start the tool call.
                    if (ctx.signal.aborted) {
                        throw ctx.signal.reason;
                    }
                    const callId = this.callIdGiver.next();
                    const { promise, resolve, reject } = makePromise();
                    const cleaner = __addDisposableResource(env_1, new Cleaner(), false);
                    this.ongoingToolCalls.set(callId, {
                        callId,
                        resolve,
                        reject,
                        reportStatus: status => ctx.status(status),
                        reportWarning: warning => ctx.warn(warning),
                    });
                    cleaner.register(() => {
                        this.ongoingToolCalls.delete(callId);
                    });
                    this.channel.send({
                        type: "callTool",
                        callId,
                        name: toolDefinition.function.name,
                        arguments: args,
                    });
                    ctx.signal.addEventListener("abort", () => {
                        if (this.status === "disposed") {
                            return;
                        }
                        this.channel.send({
                            type: "abortToolCall",
                            callId,
                        });
                        reject(ctx.signal.reason);
                    }, { once: true });
                    return await promise;
                }
                catch (e_1) {
                    env_1.error = e_1;
                    env_1.hasError = true;
                }
                finally {
                    __disposeResources(env_1);
                }
            },
        });
    }
}
/**
 * Represents a tool use session backed by multiple plugins. Don't construct this class yourself.
 *
 * @public
 */
class MultiRemoteToolUseSession {
    static async createUsingPredictionProcess(pluginsPort, pluginIdentifiers, predictionContextIdentifier, token, logger, stack) {
        // Start initializing all the sessions in parallel. This is OK because usually all the plugins
        // are already loaded for the prediction process anyway.
        const results = await Promise.allSettled(pluginIdentifiers.map(pluginIdentifier => SingleRemoteToolUseSession.create(pluginsPort, pluginIdentifier, {
            type: "predictionProcess",
            pci: predictionContextIdentifier,
            token,
        }, logger, stack)));
        const failed = results.filter(result => result.status === "rejected");
        if (failed.length > 0) {
            // Some sessions failed to initialize. We need to terminate all the sessions that
            // successfully initialized.
            for (const result of results) {
                if (result.status === "fulfilled") {
                    try {
                        result.value[Symbol.dispose]();
                    }
                    catch (error) {
                        logger.error("Failed to dispose a session after initialization failure.", error);
                    }
                }
            }
            throw new AggregateError(failed.map(result => result.reason), "Failed to initialize some tool use sessions.");
        }
        return new MultiRemoteToolUseSession(results.map(result => result.value), logger);
    }
    constructor(sessions, logger) {
        this.sessions = sessions;
        this.logger = logger;
        this.tools = [];
        this.tools = sessions.flatMap(session => session.tools);
    }
    [Symbol.dispose]() {
        // Dispose all the sessions.
        for (const session of this.sessions) {
            try {
                session[Symbol.dispose]();
            }
            catch (error) {
                this.logger.error("Failed to dispose a session.", error);
            }
        }
    }
}

const pluginToolsOptsSchema = zod.z.object({
    pluginConfig: kvConfigSchema.optional(),
    workingDirectory: zod.z.string().optional(),
});
const registerDevelopmentPluginOptsSchema = zod.z.object({
    manifest: pluginManifestSchema,
});
/**
 * @public
 *
 * The namespace for file-related operations. Currently no public-facing methods.
 */
class PluginsNamespace {
    /** @internal */
    constructor(
    /** @internal */
    port, client, validator, parentLogger, rootLogger) {
        this.port = port;
        this.client = client;
        this.validator = validator;
        this.rootLogger = rootLogger;
        this.logger = new SimpleLogger("Plugins", parentLogger);
    }
    /**
     * @experimental [EXP-PLUGIN-CORE] Plugin support is still in development. This may change in the
     * future without warning.
     */
    async registerDevelopmentPlugin(opts) {
        const stack = getCurrentStack(1);
        this.validator.validateMethodParamOrThrow("plugins", "registerDevelopmentPlugin", "opts", registerDevelopmentPluginOptsSchema, opts, stack);
        const { promise, resolve } = makePromise();
        const channel = this.port.createChannel("registerDevelopmentPlugin", opts, message => {
            if (message.type === "ready") {
                resolve({
                    clientIdentifier: message.clientIdentifier,
                    clientPasskey: message.clientPasskey,
                });
            }
        }, { stack });
        let unregisterCalled = false;
        const unregister = async () => {
            if (unregisterCalled) {
                return;
            }
            unregisterCalled = true;
            channel.send({ type: "end" });
            const { promise, resolve } = makePromise();
            channel.onClose.subscribeOnce(resolve);
            await promise;
        };
        const base = await promise;
        return {
            ...base,
            unregister,
        };
    }
    /**
     * Requests LM Studio to reindex all the plugins.
     *
     * CAVEAT: Currently, we do not wait for the reindex to complete before returning. In the future,
     * we will change this behavior and only return after the reindex is completed.
     *
     * @experimental [EXP-PLUGIN-CORE] Plugin support is still in development. This may change in the
     * future without warning.
     */
    async reindexPlugins() {
        const stack = getCurrentStack(1);
        await this.port.callRpc("reindexPlugins", undefined, { stack });
    }
    /**
     * If this client is currently running as a plugin, get the self registration host which can be
     * used to register hooks.
     *
     * @deprecated This method is used by plugins internally to register hooks. Do not use directly.
     */
    getSelfRegistrationHost() {
        return new PluginSelfRegistrationHost(this.port, this.client, this.rootLogger, this.validator);
    }
    /**
     * Starts a tool use session use any config specifier.
     */
    async internalStartToolUseSession(pluginIdentifier, pluginConfigSpecifier, _stack) {
        return await SingleRemoteToolUseSession.create(this.port, pluginIdentifier, pluginConfigSpecifier, this.logger);
    }
    /**
     * Start a tool use session with a plugin. Note, this method must be used with "Explicit Resource
     * Management". That is, you should use it like so:
     *
     * ```typescript
     * using pluginTools = await client.plugins.pluginTools("owner/name", { ... });
     * // ^ Notice the `using` keyword here.
     * ```
     *
     * If you do not use `using`, you must call `pluginTools[Symbol.dispose]()` after you are done.
     * Otherwise, there will be a memory leak and the plugins you requested tools from will be loaded
     * indefinitely.
     *
     * @experimental [EXP-USE-USE-PLUGIN-TOOLS] Using tools from other applications is still in
     * development. This may change in the future without warning.
     */
    async pluginTools(pluginIdentifier, opts = {}) {
        const stack = getCurrentStack(1);
        [pluginIdentifier, opts] = this.validator.validateMethodParamsOrThrow("plugins", "pluginTools", ["pluginIdentifier", "opts"], [artifactIdentifierSchema, pluginToolsOptsSchema], [pluginIdentifier, opts], stack);
        return await this.internalStartToolUseSession(pluginIdentifier, {
            type: "direct",
            config: opts.pluginConfig ?? emptyKVConfig,
            workingDirectoryPath: opts.workingDirectory,
        });
    }
    /**
     * Start a tool use session associated with a prediction process.
     *
     * This method is used internally by processing controllers and will be stripped by the internal
     * tag.
     *
     * @internal
     */
    async startToolUseSessionUsingPredictionProcess(pluginIdentifiers, predictionContextIdentifier, token, stack) {
        return await MultiRemoteToolUseSession.createUsingPredictionProcess(this.port, pluginIdentifiers, predictionContextIdentifier, token, this.logger, stack);
    }
    /**
     * @experimental [EXP-GEN-PREDICT] Using generator plugins programmatically is still in
     * development. This may change in the future without warning.
     */
    createGeneratorHandle(pluginIdentifier) {
        return new LLMGeneratorHandle(this.port, pluginIdentifier, this.validator, null, this.logger);
    }
    /**
     * Creates a generator handle that is already associated with a prediction process.
     *
     * This method is used internally by the processing controllers to create generator handles. It is
     * marked as internal and will be stripped.
     *
     * @internal
     */
    createGeneratorHandleAssociatedWithPredictionProcess(pluginIdentifier, predictionContextIdentifier, token) {
        return new LLMGeneratorHandle(this.port, pluginIdentifier, this.validator, { pci: predictionContextIdentifier, token }, this.logger);
    }
}

const artifactDownloadPlannerDownloadOptsSchema = zod.z.object({
    onStartFinalizing: zod.z.function().optional(),
    onProgress: zod.z.function().optional(),
    signal: zod.z.instanceof(AbortSignal).optional(),
});
/**
 * Represents a planner to download an artifact. The plan is not guaranteed to be ready until you
 * await on the method "untilReady".
 *
 * @deprecated [DEP-HUB-API-ACCESS] LM Studio Hub API access is still in active development. Stay
 * tuned for updates.
 * @public
 */
class ArtifactDownloadPlanner {
    /**
     * @internal Do not construct this class yourself.
     */
    constructor(owner, name, onPlanUpdated, 
    /** @internal */
    channel, validator, onDisposed) {
        this.owner = owner;
        this.name = name;
        this.onPlanUpdated = onPlanUpdated;
        this.channel = channel;
        this.validator = validator;
        this.onDisposed = onDisposed;
        this.readyDeferredPromise = makePromise();
        this.isReadyBoolean = false;
        this.currentDownload = null;
        /**
         * If we received an error after the download starts, we will just raise the error in the download
         * promise.
         *
         * However, if the error was received before download was called (e.g. plan resolution failed),
         * we will store the error here and throw it as soon as `.download` is called. In addition, we
         * will also raise the error in the ready promise. However, since it is not required to attach
         * a listener there
         */
        this.errorReceivedBeforeDownloadStart = null;
        this.logger = new SimpleLogger(`ArtifactDownloadPlanner(${owner}/${name})`);
        // Don't unhandled rejection - we don't require user to await on this promise.
        this.readyDeferredPromise.promise.catch(() => { });
        this.planValue = {
            nodes: [
                {
                    type: "artifact",
                    owner,
                    name,
                    state: "pending",
                    dependencyNodes: [],
                },
            ],
            downloadSizeBytes: 0,
        };
        this.channel.onMessage.subscribe(message => {
            const messageType = message.type;
            switch (messageType) {
                case "planReady": {
                    this.isReadyBoolean = true;
                    this.readyDeferredPromise.resolve();
                    this.planValue = message.plan;
                    break;
                }
                case "planUpdated": {
                    this.planValue = message.plan;
                    safeCallCallback(this.logger, "onPlanUpdated", this.onPlanUpdated, [message.plan]);
                    break;
                }
                case "success": {
                    if (this.currentDownload === null) {
                        throw new Error("Unexpected: received success message without a download.");
                    }
                    this.currentDownload.downloadFinished();
                    break;
                }
                case "downloadProgress": {
                    if (this.currentDownload === null) {
                        throw new Error("Unexpected: received progress message without a download.");
                    }
                    this.currentDownload.progressUpdate(message.update);
                    break;
                }
                case "startFinalizing": {
                    if (this.currentDownload === null) {
                        throw new Error("Unexpected: received startFinalizing message without a download.");
                    }
                    this.currentDownload.startFinalizing();
                    break;
                }
            }
        });
        this.channel.onError.subscribeOnce(error => {
            if (this.currentDownload === null) {
                this.errorReceivedBeforeDownloadStart = error;
                this.readyDeferredPromise.reject(error);
            }
            else {
                this.currentDownload.downloadFailed(error);
            }
        });
    }
    [Symbol.dispose]() {
        this.channel.send({ type: "cancel" });
        this.onDisposed();
    }
    isReady() {
        return this.isReadyBoolean;
    }
    async untilReady() {
        return await this.readyDeferredPromise.promise;
    }
    getPlan() {
        return this.planValue;
    }
    /**
     * Download this artifact. `download` can only be called once.
     */
    async download(opts) {
        const stack = getCurrentStack(1);
        opts = this.validator.validateMethodParamOrThrow("ArtifactDownloadPlanner", "download", "opts", artifactDownloadPlannerDownloadOptsSchema, opts, stack);
        const { onProgress, onStartFinalizing, signal = new AbortController().signal } = opts;
        if (this.currentDownload !== null) {
            throw new Error("You can only call `download` once for each planner.");
        }
        if (this.errorReceivedBeforeDownloadStart !== null) {
            // There has been an error. Raise it immediately.
            const error = this.errorReceivedBeforeDownloadStart;
            this.errorReceivedBeforeDownloadStart = null;
            throw error;
        }
        const { promise, resolve, reject } = makePromise();
        this.currentDownload = {
            downloadFinished: () => {
                resolve();
            },
            startFinalizing: () => {
                safeCallCallback(this.logger, "onStartFinalizing", onStartFinalizing, []);
            },
            progressUpdate: update => {
                safeCallCallback(this.logger, "onProgress", onProgress, [update]);
            },
            downloadFailed: error => {
                reject(error);
            },
        };
        this.channel.send({ type: "commit" });
        if (signal.aborted) {
            this.channel.send({ type: "cancel" });
        }
        else {
            signal.addEventListener("abort", () => {
                this.channel.send({ type: "cancel" });
            });
        }
        return await promise.catch(error => {
            if (signal.aborted) {
                // If the signal was aborted, we need to reject with the reason of the abort.
                throw signal.reason;
            }
            else {
                // Otherwise, we just reject with the error.
                throw error;
            }
        });
    }
}

const downloadOptsSchema = zod.z.object({
    onProgress: zod.z.function().optional(),
    onStartFinalizing: zod.z.function().optional(),
    signal: zod.z.instanceof(AbortSignal).optional(),
});
/** @public */
class ModelSearchResultDownloadOption {
    /** @internal */
    constructor(
    /** @internal */
    repositoryPort, 
    /** @internal */
    validator, logger, data) {
        this.repositoryPort = repositoryPort;
        this.validator = validator;
        this.logger = logger;
        this.data = data;
        this.quantization = data.quantization;
        this.name = data.name;
        this.sizeBytes = data.sizeBytes;
        this.fitEstimation = this.data.fitEstimation;
        this.indexedModelIdentifier = this.data.indexedModelIdentifier;
    }
    isRecommended() {
        return this.data.recommended ?? false;
    }
    /**
     * Download the model. Returns the model key which can be used to load the model.
     */
    async download(opts = {}) {
        const stack = getCurrentStack(1);
        this.validator.validateMethodParamOrThrow("ModelSearchResultDownloadOption", "download", "opts", downloadOptsSchema, opts, stack);
        const { promise, resolve, reject } = makePromise();
        const channel = this.repositoryPort.createChannel("downloadModel", {
            downloadIdentifier: this.data.downloadIdentifier,
        }, message => {
            switch (message.type) {
                case "downloadProgress": {
                    safeCallCallback(this.logger, "onProgress", opts.onProgress, [message.update]);
                    break;
                }
                case "startFinalizing": {
                    safeCallCallback(this.logger, "onStartFinalizing", opts.onStartFinalizing, []);
                    break;
                }
                case "success": {
                    resolve(message.defaultIdentifier);
                    break;
                }
                default: {
                    const exhaustiveCheck = message;
                    throw new Error(`Unexpected message type: ${exhaustiveCheck}`);
                }
            }
        }, { stack });
        channel.onError.subscribeOnce(error => {
            if (opts.signal?.aborted) {
                reject(opts.signal.reason);
            }
            else {
                reject(error);
            }
        });
        channel.onClose.subscribeOnce(() => {
            if (opts.signal?.aborted) {
                reject(opts.signal.reason);
            }
            else {
                reject(new Error("Channel closed unexpectedly."));
            }
        });
        const abortListener = () => {
            channel.send({ type: "cancel" });
        };
        opts.signal?.addEventListener("abort", abortListener);
        promise.finally(() => {
            opts.signal?.removeEventListener("abort", abortListener);
        });
        return await promise;
    }
}

/** @public */
class ModelSearchResultEntry {
    /**
     * @internal
     */
    constructor(
    /** @internal */
    repositoryPort, 
    /** @internal */
    validator, logger, data) {
        this.repositoryPort = repositoryPort;
        this.validator = validator;
        this.logger = logger;
        this.data = data;
        this.name = data.name;
    }
    isExactMatch() {
        return this.data.exact ?? false;
    }
    isStaffPick() {
        return this.data.staffPick ?? false;
    }
    async getDownloadOptions() {
        const { results } = await this.repositoryPort.callRpc("getModelDownloadOptions", {
            modelSearchResultIdentifier: this.data.identifier,
        });
        return results.map(data => new ModelSearchResultDownloadOption(this.repositoryPort, this.validator, this.logger, data));
    }
}

const downloadArtifactOptsSchema = zod.z.object({
    owner: zod.z.string(),
    name: zod.z.string(),
    revisionNumber: zod.z.number(),
    path: zod.z.string(),
    onProgress: zod.z.function().optional(),
    onStartFinalizing: zod.z.function().optional(),
    signal: zod.z.instanceof(AbortSignal).optional(),
});
const pushArtifactOptsSchema = zod.z.object({
    path: zod.z.string(),
    description: zod.z.string().optional(),
    makePrivate: zod.z.boolean().optional(),
    writeRevision: zod.z.boolean().optional(),
    overrides: jsonSerializableSchema.optional(),
    onMessage: zod.z.function().optional(),
});
const ensureAuthenticatedOptsSchema = zod.z.object({
    onAuthenticationUrl: zod.z.function(),
});
const loginWithPreAuthenticatedKeysOptsSchema = zod.z.object({
    keyId: zod.z.string(),
    publicKey: zod.z.string(),
    privateKey: zod.z.string(),
});
zod.z.object({
    userName: zod.z.string(),
});
const createArtifactDownloadPlannerOptsSchema = zod.z.object({
    owner: zod.z.string(),
    name: zod.z.string(),
    onPlanUpdated: zod.z.function().optional(),
});
/** @public */
class RepositoryNamespace {
    /** @internal */
    constructor(repositoryPort, validator, parentLogger) {
        this.repositoryPort = repositoryPort;
        this.validator = validator;
        this.downloadPlanFinalizationRegistry = new FinalizationRegistry(({ owner, name }) => {
            this.logger.warn(`
      A download plan for artifact ${owner}/${name} has been garbage collected without being
      disposed. Please make sure you are creating the download plan with the "using" keyword.

      This is a memory leak and needs to be fixed.
    `);
        });
        this.logger = new SimpleLogger("Repository", parentLogger);
    }
    async searchModels(opts) {
        const stack = getCurrentStack(1);
        opts = this.validator.validateMethodParamOrThrow("repository", "search", "opts", modelSearchOptsSchema, opts, stack);
        const { results } = await this.repositoryPort.callRpc("searchModels", { opts }, { stack });
        return results.map(data => new ModelSearchResultEntry(this.repositoryPort, this.validator, this.logger, data));
    }
    /**
     * @deprecated [DEP-HUB-API-ACCESS] LM Studio Hub API access is still in active development. Stay
     * tuned for updates.
     */
    async installPluginDependencies(pluginFolder) {
        const stack = getCurrentStack(1);
        this.validator.validateMethodParamOrThrow("repository", "installPluginDependencies", "pluginFolder", zod.z.string(), pluginFolder, stack);
        await this.repositoryPort.callRpc("installPluginDependencies", { pluginFolder }, { stack });
    }
    /**
     * @deprecated [DEP-HUB-API-ACCESS] LM Studio Hub API access is still in active development. Stay
     * tuned for updates.
     */
    async downloadArtifact(opts) {
        const stack = getCurrentStack(1);
        this.validator.validateMethodParamOrThrow("client.repository", "downloadArtifact", "opts", downloadArtifactOptsSchema, opts, stack);
        const { owner, name, revisionNumber, path, onProgress, onStartFinalizing, signal } = opts;
        const { promise, resolve, reject } = makePromise();
        const channel = this.repositoryPort.createChannel("downloadArtifact", { artifactOwner: owner, artifactName: name, revisionNumber, path }, message => {
            switch (message.type) {
                case "downloadProgress": {
                    safeCallCallback(this.logger, "onProgress", onProgress, [message.update]);
                    break;
                }
                case "startFinalizing": {
                    safeCallCallback(this.logger, "onStartFinalizing", onStartFinalizing, []);
                    break;
                }
                case "success": {
                    resolve();
                    break;
                }
                default: {
                    const exhaustiveCheck = message;
                    throw new Error(`Unexpected message type: ${exhaustiveCheck}`);
                }
            }
        }, { stack });
        channel.onError.subscribeOnce(reject);
        channel.onClose.subscribeOnce(() => {
            if (signal?.aborted) {
                reject(signal.reason);
            }
            else {
                reject(new Error("Channel closed unexpectedly."));
            }
        });
        const abortListener = () => {
            channel.send({ type: "cancel" });
        };
        signal?.addEventListener("abort", abortListener);
        promise.finally(() => {
            signal?.removeEventListener("abort", abortListener);
        });
        return await promise;
    }
    /**
     * @deprecated [DEP-HUB-API-ACCESS] LM Studio Hub API access is still in active development. Stay
     * tuned for updates.
     */
    async pushArtifact(opts) {
        const stack = getCurrentStack(1);
        const { path, description, makePrivate, writeRevision, overrides, onMessage } = this.validator.validateMethodParamOrThrow("repository", "pushArtifact", "opts", pushArtifactOptsSchema, opts, stack);
        const channel = this.repositoryPort.createChannel("pushArtifact", { path, description, makePrivate, writeRevision, overrides }, message => {
            const type = message.type;
            switch (type) {
                case "message": {
                    safeCallCallback(this.logger, "onMessage", onMessage, [message.message]);
                    break;
                }
                default: {
                    const exhaustiveCheck = type;
                    throw new Error(`Unexpected message type: ${exhaustiveCheck}`);
                }
            }
        }, { stack });
        const { promise, resolve, reject } = makePromise();
        channel.onError.subscribeOnce(reject);
        channel.onClose.subscribeOnce(resolve);
        await promise;
    }
    /**
     * @deprecated [DEP-HUB-API-ACCESS] LM Studio Hub API access is still in active development. Stay
     * tuned for updates.
     */
    async getLocalArtifactFileList(path) {
        const stack = getCurrentStack(1);
        this.validator.validateMethodParamOrThrow("repository", "getLocalArtifactFileList", "path", zod.z.string(), path, stack);
        const { fileList } = await this.repositoryPort.callRpc("getLocalArtifactFiles", { path }, { stack });
        return fileList;
    }
    /**
     * @deprecated [DEP-HUB-API-ACCESS] LM Studio Hub API access is still in active development. Stay
     * tuned for updates.
     */
    async ensureAuthenticated(opts) {
        const stack = getCurrentStack(1);
        this.validator.validateMethodParamOrThrow("repository", "ensureAuthenticated", "opts", ensureAuthenticatedOptsSchema, opts, stack);
        const { promise, resolve, reject } = makePromise();
        const channel = this.repositoryPort.createChannel("ensureAuthenticated", undefined, message => {
            const type = message.type;
            switch (type) {
                case "authenticationUrl": {
                    safeCallCallback(this.logger, "onAuthenticationUrl", opts.onAuthenticationUrl, [
                        message.url,
                    ]);
                    break;
                }
                case "authenticated": {
                    resolve();
                    break;
                }
                default: {
                    const exhaustiveCheck = type;
                    throw new Error(`Unexpected message type: ${exhaustiveCheck}`);
                }
            }
        });
        channel.onError.subscribeOnce(reject);
        await promise;
    }
    async loginWithPreAuthenticatedKeys(opts) {
        const stack = getCurrentStack(1);
        this.validator.validateMethodParamOrThrow("repository", "loginWithPreAuthenticatedKeys", "opts", loginWithPreAuthenticatedKeysOptsSchema, opts, stack);
        const { keyId, publicKey, privateKey } = opts;
        const { userName } = await this.repositoryPort.callRpc("loginWithPreAuthenticatedKeys", { keyId, publicKey, privateKey }, { stack });
        return { userName };
    }
    /**
     * @deprecated [DEP-HUB-API-ACCESS] LM Studio Hub API access is still in active development. Stay
     * tuned for updates.
     */
    createArtifactDownloadPlanner(opts) {
        const { owner, name, onPlanUpdated } = this.validator.validateMethodParamOrThrow("repository", "createArtifactDownloadPlanner", "opts", createArtifactDownloadPlannerOptsSchema, opts);
        const stack = getCurrentStack(1);
        const channel = this.repositoryPort.createChannel("createArtifactDownloadPlan", { owner, name }, undefined, // Don't listen to the messages yet.
        { stack });
        const planner = new ArtifactDownloadPlanner(owner, name, onPlanUpdated, channel, this.validator, () => {
            this.downloadPlanFinalizationRegistry.unregister(planner);
        });
        this.downloadPlanFinalizationRegistry.register(planner, { owner, name }, planner);
        return planner;
    }
}

const startHttpServerOptsSchema = zod.z.object({
    port: zod.z
        .number()
        .int()
        .min(1)
        .max(65535)
        .describe("Port to run the API server on. Must be between 1 and 65535."),
    cors: zod.z
        .boolean()
        .describe("Enable CORS on the API server. Allows any website to access the server."),
});
/** @public */
class SystemNamespace {
    /** @internal */
    constructor(systemPort, validator, parentLogger) {
        this.systemPort = systemPort;
        this.validator = validator;
        this.logger = new SimpleLogger("System", parentLogger);
    }
    async listDownloadedModels(domain) {
        const stack = getCurrentStack(1);
        domain = this.validator.validateMethodParamOrThrow("client.system", "listDownloadedModels", "domain", zod.z.union([zod.z.literal("llm"), zod.z.literal("embedding"), zod.z.undefined()]), domain, stack);
        const models = await this.systemPort.callRpc("listDownloadedModels", undefined, {
            stack: getCurrentStack(1),
        });
        if (domain === undefined) {
            return models;
        }
        return models.filter(model => model.type === domain);
    }
    async whenDisconnected() {
        const stack = getCurrentStack(1);
        const channel = this.systemPort.createChannel("alive", undefined, undefined, { stack });
        const { promise, resolve } = makePromise();
        channel.onError.subscribeOnce(resolve);
        channel.onClose.subscribeOnce(resolve);
        await promise;
    }
    async notify(notification) {
        const stack = getCurrentStack(1);
        notification = this.validator.validateMethodParamOrThrow("client.system", "notify", "notification", backendNotificationSchema, notification, stack);
        await this.systemPort.callRpc("notify", notification, { stack });
    }
    async getLMStudioVersion() {
        const stack = getCurrentStack(1);
        return await this.systemPort.callRpc("version", undefined, { stack });
    }
    /**
     * Sets an experiment flags for LM Studio. This is an unstable API and may change without notice.
     *
     * @experimental
     */
    async unstable_setExperimentFlag(flag, value) {
        const stack = getCurrentStack(1);
        [flag, value] = this.validator.validateMethodParamsOrThrow("client.system", "setExperimentFlag", ["flag", "value"], [zod.z.string(), zod.z.boolean()], [flag, value], stack);
        await this.systemPort.callRpc("setExperimentFlag", { code: flag, value }, { stack });
    }
    /**
     * Gets all experiment flags for LM Studio. This is an unstable API and may change without notice.
     *
     * @experimental
     */
    async unstable_getExperimentFlags() {
        const stack = getCurrentStack(1);
        return await this.systemPort.callRpc("getExperimentFlags", undefined, { stack });
    }
    /**
     * Starts the API server on the specified port.
     *
     * @experimental
     */
    async startHttpServer(opts) {
        const stack = getCurrentStack(1);
        opts = this.validator.validateMethodParamOrThrow("client.system", "startHttpServer", "args", startHttpServerOptsSchema, opts);
        return await this.systemPort.callRpc("startHttpServer", { port: opts.port, cors: opts.cors }, {
            stack,
        });
    }
    /**
     * Stops the API server if it is running.
     *
     * @experimental
     */
    async stopHttpServer() {
        const stack = getCurrentStack(1);
        return await this.systemPort.callRpc("stopHttpServer", undefined, { stack });
    }
}

const constructorOptsSchema = zod.z
    .object({
    logger: zod.z.any().optional(),
    baseUrl: zod.z.string().optional(),
    verboseErrorMessages: zod.z.boolean().optional(),
    clientIdentifier: zod.z.string().optional(),
    clientPasskey: zod.z.string().optional(),
    // Internal testing options
    disableConnection: zod.z.boolean().optional(),
    llmPort: zod.z.any().optional(),
    embeddingPort: zod.z.any().optional(),
    systemPort: zod.z.any().optional(),
    diagnosticsPort: zod.z.any().optional(),
    retrievalPort: zod.z.any().optional(),
    filesPort: zod.z.any().optional(),
    repositoryPort: zod.z.any().optional(),
    pluginsPort: zod.z.any().optional(),
})
    .strict();
/** @public */
class LMStudioClient {
    /** @internal */
    validateBaseUrlOrThrow(baseUrl) {
        let url;
        try {
            url = new URL(baseUrl);
        }
        catch (e) {
            this.logger.throw(text `
        Failed to construct LMStudioClient. The baseUrl passed in is invalid. Received: ${baseUrl}
      `);
        }
        if (!["ws:", "wss:"].includes(url.protocol)) {
            this.logger.throw(text `
        Failed to construct LMStudioClient. The baseUrl passed in must have protocol "ws" or "wss". 
        Received: ${baseUrl}
      `);
        }
        if (url.search !== "") {
            this.logger.throw(text `
        Failed to construct LMStudioClient. The baseUrl passed contains search parameters
        ("${url.search}").
      `);
        }
        if (url.hash !== "") {
            this.logger.throw(text `
        Failed to construct LMStudioClient. The baseUrl passed contains a hash ("${url.hash}").
      `);
        }
        if (url.username !== "" || url.password !== "") {
            this.logger.throw(text `
        Failed to construct LMStudioClient. The baseUrl passed contains a username or password. We
        do not support these in the baseUrl. Received: ${baseUrl}
      `);
        }
        if (baseUrl.endsWith("/")) {
            this.logger.throw(text `
        Failed to construct LMStudioClient. The baseUrl passed in must not end with a "/". If you
        are reverse-proxying, you should remove the trailing slash from the baseUrl. Received:
        ${baseUrl}
      `);
        }
    }
    async isLocalhostWithGivenPortLMStudioServer(port) {
        const response = await fetch(`http://127.0.0.1:${port}/lmstudio-greeting`);
        if (response.status !== 200) {
            throw new Error("Status is not 200.");
        }
        const json = await response.json();
        if (json?.lmstudio !== true) {
            throw new Error("Not an LM Studio server.");
        }
        return port;
    }
    /**
     * Guess the base URL of the LM Studio server by visiting localhost on various default ports.
     */
    async guessBaseUrl(stack) {
        if (getHostedEnv() !== null) {
            return Promise.resolve("Using hosted env");
        }
        // On browser, those apiServerPorts are not accessible anyway. We will just try to see if we can
        // reach the server on 127.0.0.1:1234 (the default port).
        if (process$1.browser) {
            try {
                this.isLocalhostWithGivenPortLMStudioServer(1234);
                return "ws://127.0.0.1:1234";
            }
            catch (error) {
                text `
          ${chalk.redBright("Failed to connect to LM Studio.")}

          Is LM Studio running? If not, please start it by running:

              ${chalk.yellow("lms server start --cors")}

          If you are attempting to connect to LM Studio on a separate machine, please provide the
          baseUrl option when creating the LMStudioClient:

              ${chalk.blueBright(text `
                const client = new LMStudioClient({ baseUrl: 'ws://<host_name>:<port>' });
              `)}

          ${chalk.white("(i) For more information, refer to the LM Studio documentation:")}

              ${chalk.gray("https://lmstudio.ai/docs/local-server")}
        `;
            }
        }
        return Promise.any(apiServerPorts.map(this.isLocalhostWithGivenPortLMStudioServer)).then(port => `ws://127.0.0.1:${port}`, () => {
            throw makePrettyError(text `
            ${chalk.redBright("Failed to connect to LM Studio.")}

            Please make sure LM Studio is running on your machine.
            
            If you are attempting to connect to LM Studio on a separate machine, please provide the
            baseUrl option when creating the LMStudioClient:

                ${chalk.blueBright(text `
                  const client = new LMStudioClient({ baseUrl: 'ws://<host_name>:<port>' });
                `)}

            ${chalk.white("(i) For more information, refer to the LM Studio documentation:")}

                ${chalk.gray("https://lmstudio.ai/docs/local-server")}
          `, stack);
        });
    }
    createPort(namespace, name, backendInterface) {
        return createAuthenticatedClientPort(backendInterface, this.resolvingBaseUrl, namespace, this.clientIdentifier, this.clientPasskey, new SimpleLogger(name, this.logger), {
            errorDeserializer: friendlyErrorDeserializer,
            verboseErrorMessage: this.verboseErrorMessages,
        });
    }
    constructor(opts = {}) {
        const { logger, baseUrl, verboseErrorMessages, clientIdentifier, clientPasskey, disableConnection, llmPort, embeddingPort, systemPort, diagnosticsPort, retrievalPort, filesPort, repositoryPort, pluginsPort, } = new Validator().validateConstructorParamOrThrow("LMStudioClient", "opts", constructorOptsSchema, opts);
        if (globalThis.__LMS_PLUGIN_CONTEXT && opts.baseUrl === undefined) {
            throw new Error(text `
          You cannot create a local LMStudioClient in a plugin context. To use LM Studio APIs, use
          the "client" property attached to the Controllers.

          For example, instead of:

          ${"const client = new LMStudioClient(); // <-- Error\n" +
                "export async function generate(ctl: GeneratorController) {\n" +
                "  const model = await client.llm.model(...);\n" +
                "}"}

          Do this:
            
          ${"export async function generate(ctl: GeneratorController) {\n" +
                "  const model = await ctl.client.llm.model(...);\n" +
                "}"}

          If you need to connect to a remote LM Studio, you should pass in the \`baseUrl\` option to
          the LMStudioClient constructor:

          ${"const client = new LMStudioClient({ baseUrl: 'ws://<host_name>:<port>' });"}
        `);
        }
        this.logger = new SimpleLogger("LMStudioClient", logger);
        this.clientIdentifier = clientIdentifier ?? lmsIsomorphic.generateRandomBase64(18);
        this.clientPasskey = clientPasskey ?? lmsIsomorphic.generateRandomBase64(18);
        const stack = getCurrentStack(1);
        if (disableConnection) {
            this.resolvingBaseUrl = new Promise(() => undefined);
        }
        else {
            if (baseUrl === undefined) {
                this.resolvingBaseUrl = this.guessBaseUrl(verboseErrorMessages ? stack : undefined);
            }
            else {
                this.validateBaseUrlOrThrow(baseUrl);
                this.resolvingBaseUrl = baseUrl;
            }
        }
        this.verboseErrorMessages = verboseErrorMessages ?? true;
        this.llmPort = llmPort ?? this.createPort("llm", "LLM", createLlmBackendInterface());
        this.embeddingPort =
            embeddingPort ?? this.createPort("embedding", "Embedding", createEmbeddingBackendInterface());
        this.systemPort =
            systemPort ?? this.createPort("system", "System", createSystemBackendInterface());
        this.diagnosticsPort =
            diagnosticsPort ??
                this.createPort("diagnostics", "Diagnostics", createDiagnosticsBackendInterface());
        this.filesPort = filesPort ?? this.createPort("files", "Files", createFilesBackendInterface());
        this.repositoryPort =
            repositoryPort ??
                this.createPort("repository", "Repository", createRepositoryBackendInterface());
        this.pluginsPort =
            pluginsPort ?? this.createPort("plugins", "Plugins", createPluginsBackendInterface());
        const validator = new Validator();
        this.llm = new LLMNamespace(this, this.llmPort, new SimpleLogger("LLM", this.logger), validator);
        this.embedding = new EmbeddingNamespace(this, this.embeddingPort, new SimpleLogger("Embedding", this.logger), validator);
        this.system = new SystemNamespace(this.systemPort, validator, this.logger);
        this.diagnostics = new DiagnosticsNamespace(this.diagnosticsPort, validator, this.logger);
        this.files = new FilesNamespace(this.filesPort, validator, this.logger);
        this.repository = new RepositoryNamespace(this.repositoryPort, validator, this.logger);
        this.plugins = new PluginsNamespace(this.pluginsPort, this, validator, this.logger, logger);
    }
    async [Symbol.asyncDispose]() {
        await Promise.all([
            this.llmPort[Symbol.asyncDispose](),
            this.embeddingPort[Symbol.asyncDispose](),
            this.systemPort[Symbol.asyncDispose](),
            this.diagnosticsPort[Symbol.asyncDispose](),
            this.filesPort[Symbol.asyncDispose](),
            this.repositoryPort[Symbol.asyncDispose](),
            this.pluginsPort[Symbol.asyncDispose](),
        ]);
    }
}

exports.Chat = Chat;
exports.ChatMessage = ChatMessage;
exports.FileHandle = FileHandle;
exports.LMStudioClient = LMStudioClient;
exports.MaybeMutable = MaybeMutable;
exports.ToolCallRequestError = ToolCallRequestError;
exports.createConfigSchematics = createConfigSchematics;
exports.kvValueTypesLibrary = kvValueTypesLibrary;
exports.rawFunctionTool = rawFunctionTool;
exports.text = text;
exports.tool = tool;
exports.unimplementedRawFunctionTool = unimplementedRawFunctionTool;
