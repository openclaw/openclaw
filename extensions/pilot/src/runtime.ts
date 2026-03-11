import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
import type { PluginRuntime } from "openclaw/plugin-sdk/pilot";

const { setRuntime: setPilotRuntime, getRuntime: getPilotRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Pilot runtime not initialized");
export { getPilotRuntime, setPilotRuntime };
