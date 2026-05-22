export type { PluginRuntime } from "../plugins/runtime/types.js";
type PluginRuntimeStoreKeyOptions = {
    key: string;
    errorMessage: string;
};
type PluginRuntimeStorePluginOptions = {
    pluginId: string;
    errorMessage: string;
};
type PluginRuntimeStoreOptions = PluginRuntimeStoreKeyOptions | PluginRuntimeStorePluginOptions;
/** Create a tiny mutable runtime slot with strict access when the runtime has not been initialized. */
export declare function createPluginRuntimeStore<T>(errorMessage: string): {
    setRuntime: (next: T) => void;
    clearRuntime: () => void;
    tryGetRuntime: () => T | null;
    getRuntime: () => T;
};
export declare function createPluginRuntimeStore<T>(options: PluginRuntimeStoreOptions): {
    setRuntime: (next: T) => void;
    clearRuntime: () => void;
    tryGetRuntime: () => T | null;
    getRuntime: () => T;
};
