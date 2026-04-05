import type { PluginRuntime } from "mullusi/plugin-sdk/core";
import { createPluginRuntimeStore } from "mullusi/plugin-sdk/runtime-store";

const { setRuntime: setIMessageRuntime, getRuntime: getIMessageRuntime } =
  createPluginRuntimeStore<PluginRuntime>("iMessage runtime not initialized");
export { getIMessageRuntime, setIMessageRuntime };
