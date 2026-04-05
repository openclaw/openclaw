import { createPluginRuntimeStore } from "mullusi/plugin-sdk/runtime-store";
import type { PluginRuntime } from "../runtime-api.js";

const { setRuntime: setZalouserRuntime, getRuntime: getZalouserRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Zalouser runtime not initialized");
export { getZalouserRuntime, setZalouserRuntime };
