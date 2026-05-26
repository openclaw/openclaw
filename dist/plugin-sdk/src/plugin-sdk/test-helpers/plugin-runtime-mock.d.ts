import type { PluginRuntime } from "../testing.js";
type DeepPartial<T> = {
    [K in keyof T]?: T[K] extends (...args: never[]) => unknown ? T[K] : T[K] extends ReadonlyArray<unknown> ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};
export declare function createPluginRuntimeMock(overrides?: DeepPartial<PluginRuntime>): PluginRuntime;
export {};
