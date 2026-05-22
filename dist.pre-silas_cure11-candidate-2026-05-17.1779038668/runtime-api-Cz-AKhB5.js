import { t as createPluginRuntimeStore } from "./runtime-store-DUe79kGC.js";
import "./ssrf-runtime-Cvk-tl6n.js";
import "./channel-message-D59fEK6f.js";
import "./channel-pairing-Dihocv8_.js";
//#region extensions/nextcloud-talk/src/runtime.ts
const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } = createPluginRuntimeStore({
	pluginId: "nextcloud-talk",
	errorMessage: "Nextcloud Talk runtime not initialized"
});
//#endregion
export { setNextcloudTalkRuntime as n, getNextcloudTalkRuntime as t };
