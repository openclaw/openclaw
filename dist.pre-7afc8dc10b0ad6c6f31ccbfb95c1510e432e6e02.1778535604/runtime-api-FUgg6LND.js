import { t as createPluginRuntimeStore } from "./runtime-store-Gsztj7De.js";
import "./ssrf-runtime-CkUGpkoc.js";
import "./channel-message-DLRlnHTh.js";
import "./channel-pairing-DE1ZGqNp.js";
//#region extensions/nextcloud-talk/src/runtime.ts
const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } = createPluginRuntimeStore({
	pluginId: "nextcloud-talk",
	errorMessage: "Nextcloud Talk runtime not initialized"
});
//#endregion
export { setNextcloudTalkRuntime as n, getNextcloudTalkRuntime as t };
