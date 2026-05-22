import { t as createPluginRuntimeStore } from "./runtime-store-Ck0e4Li2.js";
import "./ssrf-runtime-DiZYIPIC.js";
import "./channel-message-CBQ4P6FK.js";
import "./channel-pairing-Dn50-hnB.js";
//#region extensions/nextcloud-talk/src/runtime.ts
const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } = createPluginRuntimeStore({
	pluginId: "nextcloud-talk",
	errorMessage: "Nextcloud Talk runtime not initialized"
});
//#endregion
export { setNextcloudTalkRuntime as n, getNextcloudTalkRuntime as t };
