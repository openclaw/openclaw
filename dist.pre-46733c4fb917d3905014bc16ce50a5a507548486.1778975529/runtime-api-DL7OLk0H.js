import { t as createPluginRuntimeStore } from "./runtime-store-CSfjApnh.js";
import "./ssrf-runtime-DPexcW9I.js";
import "./channel-message-D8XpAab3.js";
import "./channel-pairing-DDbNNRH5.js";
//#region extensions/nextcloud-talk/src/runtime.ts
const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } = createPluginRuntimeStore({
	pluginId: "nextcloud-talk",
	errorMessage: "Nextcloud Talk runtime not initialized"
});
//#endregion
export { setNextcloudTalkRuntime as n, getNextcloudTalkRuntime as t };
