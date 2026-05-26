import { t as createPluginRuntimeStore } from "./runtime-store-Cigg_Veg.js";
import "./ssrf-runtime-B7YsbRmp.js";
import "./channel-message-CmG6T1ry.js";
import "./channel-pairing--8umY0wm.js";
//#region extensions/nextcloud-talk/src/runtime.ts
const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } = createPluginRuntimeStore({
	pluginId: "nextcloud-talk",
	errorMessage: "Nextcloud Talk runtime not initialized"
});
//#endregion
export { setNextcloudTalkRuntime as n, getNextcloudTalkRuntime as t };
