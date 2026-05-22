import { t as createPluginRuntimeStore } from "./runtime-store-DpA2UZdL.js";
import "./ssrf-runtime-c_uf32me.js";
import "./channel-message-DSuZIuT2.js";
import "./channel-pairing-BmI87Ctq.js";
//#region extensions/nextcloud-talk/src/runtime.ts
const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } = createPluginRuntimeStore({
	pluginId: "nextcloud-talk",
	errorMessage: "Nextcloud Talk runtime not initialized"
});
//#endregion
export { setNextcloudTalkRuntime as n, getNextcloudTalkRuntime as t };
