import { t as createPluginRuntimeStore } from "./runtime-store-D7S_cOrU.js";
import "./channel-policy-LhuEsRNm.js";
import "./ssrf-runtime-CNU9UpXf.js";
import "./channel-message-BlSItCoN.js";
import "./channel-pairing-SGLHqNpe.js";
//#region extensions/nextcloud-talk/src/runtime.ts
const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } = createPluginRuntimeStore({
	pluginId: "nextcloud-talk",
	errorMessage: "Nextcloud Talk runtime not initialized"
});
//#endregion
export { setNextcloudTalkRuntime as n, getNextcloudTalkRuntime as t };
