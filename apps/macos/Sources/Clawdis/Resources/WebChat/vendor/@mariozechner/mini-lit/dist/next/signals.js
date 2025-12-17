import { effect, Signal as PreactSignal, signal as preactSignal } from "@preact/signals-core";
/**
 * Generic Signal wrapper that works with any adapter
 */
export class Signal {
    constructor(_signal) {
        this._signal = _signal;
        this._$miniSignal$ = true;
    }
    get value() {
        return getSignalAdapter().getValue(this._signal);
    }
    set value(val) {
        getSignalAdapter().setValue(this._signal, val);
    }
    // Get the underlying signal for the adapter
    get raw() {
        return this._signal;
    }
}
/**
 * Type guard to check if a value is our Signal wrapper
 */
export function isSignal(value) {
    return value && value._$miniSignal$ === true;
}
/**
 * Default adapter for Preact signals
 */
export const preactSignalsAdapter = {
    isRawSignal: (v) => v instanceof PreactSignal,
    getValue: (s) => s.value,
    setValue: (s, v) => {
        s.value = v;
    },
    createSignal: (v) => preactSignal(v),
    subscribe: (s, cb) => s.subscribe(cb),
    createEffect: (fn) => effect(fn),
};
// Global signal adapter (default to Preact)
let signalAdapter = preactSignalsAdapter;
/**
 * Set a custom signal adapter
 */
export function setSignalAdapter(adapter) {
    signalAdapter = adapter;
}
/**
 * Get the current signal adapter
 */
export function getSignalAdapter() {
    return signalAdapter;
}
/**
 * Create a signal using the current adapter
 */
export function createSignal(value) {
    const adapter = getSignalAdapter();
    const rawSignal = adapter.createSignal(value);
    return new Signal(rawSignal);
}
/**
 * Helper to ensure we always have a signal
 * If the value is already a signal, return it
 * Otherwise wrap it in a signal
 */
export function ensureSignal(value, defaultValue) {
    const adapter = getSignalAdapter();
    // Check if it's already our Signal wrapper
    if (isSignal(value)) {
        return value;
    }
    // Check if it's a raw signal from the adapter
    if (value !== undefined && adapter.isRawSignal(value)) {
        return new Signal(value);
    }
    // Create a new signal with the value or default
    return createSignal(value !== undefined ? value : defaultValue);
}
// Re-export Preact convenience functions with our wrapper
export function signal(value) {
    return createSignal(value);
}
export { computed, effect } from "@preact/signals-core";
//# sourceMappingURL=signals.js.map