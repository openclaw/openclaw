import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } = createPluginRuntimeStore("Nextcloud Talk runtime not initialized");
export {
  getNextcloudTalkRuntime,
  setNextcloudTalkRuntime
};
