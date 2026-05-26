import type { PluginRuntime } from "../testing.js";
type DeepPartial<T> = {
    [K in keyof T]?: T[K] extends (...args: never[]) => unknown ? T[K] : T[K] extends ReadonlyArray<unknown> ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};
export type PluginRuntimeMediaMock = PluginRuntime["channel"]["media"];
export declare function createPluginRuntimeMediaMock(overrides?: Partial<PluginRuntimeMediaMock>): PluginRuntimeMediaMock;
export declare function createPluginRuntimeMock(overrides?: DeepPartial<PluginRuntime>): PluginRuntime;
export {};
