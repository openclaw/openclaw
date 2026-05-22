import { t as createPluginRuntimeStore } from "./runtime-store-C20iH_sr.js";
import "./ssrf-runtime-BxiaPFE4.js";
import "./channel-message-LSizNOBL.js";
import "./channel-pairing-mMLW1oX3.js";
//#region extensions/nextcloud-talk/src/runtime.ts
const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } = createPluginRuntimeStore({
	pluginId: "nextcloud-talk",
	errorMessage: "Nextcloud Talk runtime not initialized"
});
//#endregion
export { setNextcloudTalkRuntime as n, getNextcloudTalkRuntime as t };
