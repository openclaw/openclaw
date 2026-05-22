import { t as createPluginRuntimeStore } from "./runtime-store-BPbfSxdB.js";
import "./ssrf-runtime-R6sAwobj.js";
import "./channel-message-De31klp8.js";
import "./channel-pairing-DuptReVT.js";
//#region extensions/nextcloud-talk/src/runtime.ts
const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } = createPluginRuntimeStore({
	pluginId: "nextcloud-talk",
	errorMessage: "Nextcloud Talk runtime not initialized"
});
//#endregion
export { setNextcloudTalkRuntime as n, getNextcloudTalkRuntime as t };
