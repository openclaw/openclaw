import { t as createPluginRuntimeStore } from "./runtime-store-Cezm5nT2.js";
import "./ssrf-runtime-Db7Y0wil.js";
import "./channel-message-DkD03ToM.js";
import "./channel-pairing-C53hVVH8.js";
//#region extensions/nextcloud-talk/src/runtime.ts
const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } = createPluginRuntimeStore({
	pluginId: "nextcloud-talk",
	errorMessage: "Nextcloud Talk runtime not initialized"
});
//#endregion
export { setNextcloudTalkRuntime as n, getNextcloudTalkRuntime as t };
