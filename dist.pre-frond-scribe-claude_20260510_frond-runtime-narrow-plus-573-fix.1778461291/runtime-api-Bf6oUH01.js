import { t as createPluginRuntimeStore } from "./runtime-store-Cg9cOb9V.js";
import "./channel-policy-BLtDHk3I.js";
import "./ssrf-runtime-BdcRu7L4.js";
import "./channel-message-Bzk-dIXe.js";
import "./channel-pairing-DX2KqVMh.js";
//#region extensions/nextcloud-talk/src/runtime.ts
const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } = createPluginRuntimeStore({
	pluginId: "nextcloud-talk",
	errorMessage: "Nextcloud Talk runtime not initialized"
});
//#endregion
export { setNextcloudTalkRuntime as n, getNextcloudTalkRuntime as t };
