import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";

const { setRuntime: setSlackRuntime, getRuntime: getSlackRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Slack runtime not initialized");
export { getSlackRuntime, setSlackRuntime };
