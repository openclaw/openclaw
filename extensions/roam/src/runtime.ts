import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "../runtime-api.js";

const { setRuntime: setRoamRuntime, getRuntime: getRoamRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Roam runtime not initialized");
export { getRoamRuntime, setRoamRuntime };
