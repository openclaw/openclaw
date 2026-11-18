import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

const {
  setRuntime: setNextcloudTalkRuntime,
  getRuntime: getNextcloudTalkRuntime,
  tryGetRuntime: getOptionalNextcloudTalkRuntime,
} = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "nextcloud-talk",
  errorMessage: "Nextcloud Talk runtime not initialized",
});
export { getNextcloudTalkRuntime, getOptionalNextcloudTalkRuntime, setNextcloudTalkRuntime };
