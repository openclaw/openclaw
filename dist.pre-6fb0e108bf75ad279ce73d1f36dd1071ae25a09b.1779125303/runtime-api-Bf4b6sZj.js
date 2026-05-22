import { t as createPluginRuntimeStore } from "./runtime-store-Ck0e4Li2.js";
import "./ssrf-runtime-Cu4zbqxY.js";
import "./channel-message-DeX9rRst.js";
import "./channel-pairing-DQlMxx4e.js";
//#region extensions/nextcloud-talk/src/runtime.ts
const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } = createPluginRuntimeStore({
	pluginId: "nextcloud-talk",
	errorMessage: "Nextcloud Talk runtime not initialized"
});
//#endregion
export { setNextcloudTalkRuntime as n, getNextcloudTalkRuntime as t };
