import { t as createPluginRuntimeStore } from "./runtime-store-OWAYvd1I.js";
import "./ssrf-runtime-DeVcz7VH.js";
import "./channel-message-C3RkR_ru.js";
import "./channel-pairing-CD9Xu5WD.js";
//#region extensions/nextcloud-talk/src/runtime.ts
const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } = createPluginRuntimeStore({
	pluginId: "nextcloud-talk",
	errorMessage: "Nextcloud Talk runtime not initialized"
});
//#endregion
export { setNextcloudTalkRuntime as n, getNextcloudTalkRuntime as t };
