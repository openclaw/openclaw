//#region src/plugin-sdk/runtime-store.d.ts
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
declare function createPluginRuntimeStore<T>(errorMessage: string): {
  setRuntime: (next: T) => void;
  clearRuntime: () => void;
  tryGetRuntime: () => T | null;
  getRuntime: () => T;
};
declare function createPluginRuntimeStore<T>(options: PluginRuntimeStoreOptions): {
  setRuntime: (next: T) => void;
  clearRuntime: () => void;
  tryGetRuntime: () => T | null;
  getRuntime: () => T;
};
//#endregion
export { createPluginRuntimeStore as t };