import { t as createPluginRuntimeStore } from "./runtime-store-Cezm5nT2.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./channel-message-DMGbyII_.js";
import "./channel-pairing-N4dBc-K-.js";
//#region extensions/nextcloud-talk/src/runtime.ts
const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } = createPluginRuntimeStore({
	pluginId: "nextcloud-talk",
	errorMessage: "Nextcloud Talk runtime not initialized"
});
//#endregion
export { setNextcloudTalkRuntime as n, getNextcloudTalkRuntime as t };
