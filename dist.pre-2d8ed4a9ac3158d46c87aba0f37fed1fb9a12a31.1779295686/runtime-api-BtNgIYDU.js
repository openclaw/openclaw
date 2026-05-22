import { t as createPluginRuntimeStore } from "./runtime-store-MAmQRWGj.js";
import "./ssrf-runtime-uB3Az6qX.js";
import "./channel-message-Ds8UNA42.js";
import "./channel-pairing-B7ONSWNj.js";
//#region extensions/nextcloud-talk/src/runtime.ts
const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } = createPluginRuntimeStore({
	pluginId: "nextcloud-talk",
	errorMessage: "Nextcloud Talk runtime not initialized"
});
//#endregion
export { setNextcloudTalkRuntime as n, getNextcloudTalkRuntime as t };
