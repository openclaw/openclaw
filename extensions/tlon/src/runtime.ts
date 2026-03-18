import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "../api.js";

const { setRuntime: setTlonRuntime, getRuntime: getTlonRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Tlon runtime not initialized");
export { getTlonRuntime, setTlonRuntime };
