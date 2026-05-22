import { t as createPluginRuntimeStore } from "./runtime-store-Ck0e4Li2.js";
import "./ssrf-runtime-Dz3vPG0b.js";
import "./channel-message-BH4fSx9l.js";
import "./channel-pairing-qm6lMmPH.js";
//#region extensions/nextcloud-talk/src/runtime.ts
const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } = createPluginRuntimeStore({
	pluginId: "nextcloud-talk",
	errorMessage: "Nextcloud Talk runtime not initialized"
});
//#endregion
export { setNextcloudTalkRuntime as n, getNextcloudTalkRuntime as t };
