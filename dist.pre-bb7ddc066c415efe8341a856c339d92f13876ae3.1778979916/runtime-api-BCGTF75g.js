import { t as createPluginRuntimeStore } from "./runtime-store-CSfjApnh.js";
import "./ssrf-runtime-tmjiuH_f.js";
import "./channel-message-CnGoBBDG.js";
import "./channel-pairing-CNTI8ttR.js";
//#region extensions/nextcloud-talk/src/runtime.ts
const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } = createPluginRuntimeStore({
	pluginId: "nextcloud-talk",
	errorMessage: "Nextcloud Talk runtime not initialized"
});
//#endregion
export { setNextcloudTalkRuntime as n, getNextcloudTalkRuntime as t };
