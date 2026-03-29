"use strict";
var _EventEmitter_listeners;
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventEmitter = void 0;
const tslib_1 = require("../internal/tslib.js");
class EventEmitter {
    constructor() {
        _EventEmitter_listeners.set(this, {});
    }
    /**
     * Adds the listener function to the end of the listeners array for the event.
     * No checks are made to see if the listener has already been added. Multiple calls passing
     * the same combination of event and listener will result in the listener being added, and
     * called, multiple times.
     * @returns this, so that calls can be chained
     */
    on(event, listener) {
        const listeners = tslib_1.__classPrivateFieldGet(this, _EventEmitter_listeners, "f")[event] || (tslib_1.__classPrivateFieldGet(this, _EventEmitter_listeners, "f")[event] = []);
        listeners.push({ listener });
        return this;
    }
    /**
     * Removes the specified listener from the listener array for the event.
     * off() will remove, at most, one instance of a listener from the listener array. If any single
     * listener has been added multiple times to the listener array for the specified event, then
     * off() must be called multiple times to remove each instance.
     * @returns this, so that calls can be chained
     */
    off(event, listener) {
        const listeners = tslib_1.__classPrivateFieldGet(this, _EventEmitter_listeners, "f")[event];
        if (!listeners)
            return this;
        const index = listeners.findIndex((l) => l.listener === listener);
        if (index >= 0)
            listeners.splice(index, 1);
        return this;
    }
    /**
     * Adds a one-time listener function for the event. The next time the event is triggered,
     * this listener is removed and then invoked.
     * @returns this, so that calls can be chained
     */
    once(event, listener) {
        const listeners = tslib_1.__classPrivateFieldGet(this, _EventEmitter_listeners, "f")[event] || (tslib_1.__classPrivateFieldGet(this, _EventEmitter_listeners, "f")[event] = []);
        listeners.push({ listener, once: true });
        return this;
    }
    /**
     * This is similar to `.once()`, but returns a Promise that resolves the next time
     * the event is triggered, instead of calling a listener callback.
     * @returns a Promise that resolves the next time given event is triggered,
     * or rejects if an error is emitted.  (If you request the 'error' event,
     * returns a promise that resolves with the error).
     *
     * Example:
     *
     *   const message = await stream.emitted('message') // rejects if the stream errors
     */
    emitted(event) {
        return new Promise((resolve, reject) => {
            // TODO: handle errors
            this.once(event, resolve);
        });
    }
    _emit(event, ...args) {
        const listeners = tslib_1.__classPrivateFieldGet(this, _EventEmitter_listeners, "f")[event];
        if (listeners) {
            tslib_1.__classPrivateFieldGet(this, _EventEmitter_listeners, "f")[event] = listeners.filter((l) => !l.once);
            listeners.forEach(({ listener }) => listener(...args));
        }
    }
    _hasListener(event) {
        const listeners = tslib_1.__classPrivateFieldGet(this, _EventEmitter_listeners, "f")[event];
        return listeners && listeners.length > 0;
    }
}
exports.EventEmitter = EventEmitter;
_EventEmitter_listeners = new WeakMap();
//# sourceMappingURL=EventEmitter.js.map