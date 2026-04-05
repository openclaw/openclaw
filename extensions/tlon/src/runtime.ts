import type { PluginRuntime } from "mullusi/plugin-sdk/plugin-runtime";
import { createPluginRuntimeStore } from "mullusi/plugin-sdk/runtime-store";

const { setRuntime: setTlonRuntime, getRuntime: getTlonRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Tlon runtime not initialized");
export { getTlonRuntime, setTlonRuntime };
