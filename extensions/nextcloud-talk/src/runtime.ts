import type { PluginRuntime } from "openclaw/plugin-sdk/nextcloud-talk";
import { createPluginRuntimeStore } from "../../../src/plugin-sdk/runtime-store.js";

const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Nextcloud Talk runtime not initialized");
export { getNextcloudTalkRuntime, setNextcloudTalkRuntime };
