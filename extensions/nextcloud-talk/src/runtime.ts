import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "../runtime-api.js";

const {
	setRuntime: setNextcloudTalkRuntime,
	getRuntime: getNextcloudTalkRuntime,
} = createPluginRuntimeStore<PluginRuntime>(
	"Nextcloud Talk runtime not initialized",
);
export { getNextcloudTalkRuntime, setNextcloudTalkRuntime };
