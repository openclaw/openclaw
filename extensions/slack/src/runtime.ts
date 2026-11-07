import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const {
  setRuntime: setSlackRuntime,
  tryGetRuntime: getOptionalSlackRuntime,
  getRuntime: getSlackRuntime,
} = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "slack",
  errorMessage: "Slack runtime not initialized",
});
export { getOptionalSlackRuntime, getSlackRuntime, setSlackRuntime };
