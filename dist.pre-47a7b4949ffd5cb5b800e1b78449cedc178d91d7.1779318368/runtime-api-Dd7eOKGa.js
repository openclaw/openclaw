import { t as createPluginRuntimeStore } from "./runtime-store-Cezm5nT2.js";
import "./ssrf-runtime-BUdcoJws.js";
import "./channel-message-D2DSarag.js";
import "./channel-pairing-CtkLWg1v.js";
//#region extensions/nextcloud-talk/src/runtime.ts
const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } = createPluginRuntimeStore({
	pluginId: "nextcloud-talk",
	errorMessage: "Nextcloud Talk runtime not initialized"
});
//#endregion
export { setNextcloudTalkRuntime as n, getNextcloudTalkRuntime as t };
