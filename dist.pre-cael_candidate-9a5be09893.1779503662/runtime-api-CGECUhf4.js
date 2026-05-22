import { t as createPluginRuntimeStore } from "./runtime-store-Cezm5nT2.js";
import "./ssrf-runtime-BxfNsut3.js";
import "./channel-message-CO23hUpq.js";
import "./channel-pairing-BQ9lyBd_.js";
//#region extensions/nextcloud-talk/src/runtime.ts
const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } = createPluginRuntimeStore({
	pluginId: "nextcloud-talk",
	errorMessage: "Nextcloud Talk runtime not initialized"
});
//#endregion
export { setNextcloudTalkRuntime as n, getNextcloudTalkRuntime as t };
