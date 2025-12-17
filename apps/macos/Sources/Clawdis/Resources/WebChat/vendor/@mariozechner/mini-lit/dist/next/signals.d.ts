/**
 * Generic Signal wrapper that works with any adapter
 */
export declare class Signal<T> {
    private _signal;
    readonly _$miniSignal$: true;
    constructor(_signal: any);
    get value(): T;
    set value(val: T);
    get raw(): any;
}
/**
 * Type guard to check if a value is our Signal wrapper
 */
export declare function isSignal(value: any): value is Signal<any>;
/**
 * Interface for signal library adapters
 */
export interface SignalAdapter {
    isRawSignal(value: any): boolean;
    getValue(signal: any): any;
    setValue(signal: any, value: any): void;
    createSignal<T>(value: T): any;
    subscribe(signal: any, callback: () => void): () => void;
    createEffect(fn: () => void): () => void;
}
/**
 * Default adapter for Preact signals
 */
export declare const preactSignalsAdapter: SignalAdapter;
/**
 * Set a custom signal adapter
 */
export declare function setSignalAdapter(adapter: SignalAdapter): void;
/**
 * Get the current signal adapter
 */
export declare function getSignalAdapter(): SignalAdapter;
/**
 * Create a signal using the current adapter
 */
export declare function createSignal<T>(value: T): Signal<T>;
/**
 * Helper to ensure we always have a signal
 * If the value is already a signal, return it
 * Otherwise wrap it in a signal
 */
export declare function ensureSignal<T>(value: T | Signal<T> | undefined, defaultValue: T): Signal<T>;
export declare function signal<T>(value: T): Signal<T>;
export { computed, effect } from "@preact/signals-core";
//# sourceMappingURL=signals.d.ts.map