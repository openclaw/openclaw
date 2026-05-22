import { t as createPluginRuntimeStore } from "./runtime-store-BY975gH9.js";
import "./channel-policy-C4Te_3Ry.js";
import "./ssrf-runtime-CN3oFExA.js";
import "./channel-message-CF65m1xH.js";
import "./channel-pairing-Ccj9LOYk.js";
//#region extensions/nextcloud-talk/src/runtime.ts
const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } = createPluginRuntimeStore({
	pluginId: "nextcloud-talk",
	errorMessage: "Nextcloud Talk runtime not initialized"
});
//#endregion
export { setNextcloudTalkRuntime as n, getNextcloudTalkRuntime as t };
