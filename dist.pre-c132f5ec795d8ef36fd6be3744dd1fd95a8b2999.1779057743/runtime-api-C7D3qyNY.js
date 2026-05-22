import { t as createPluginRuntimeStore } from "./runtime-store-2ORR7yfg.js";
import "./ssrf-runtime-BDi9tXcb.js";
import "./channel-message-CHkrbl6L.js";
import "./channel-pairing-9_fRH2pa.js";
//#region extensions/nextcloud-talk/src/runtime.ts
const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } = createPluginRuntimeStore({
	pluginId: "nextcloud-talk",
	errorMessage: "Nextcloud Talk runtime not initialized"
});
//#endregion
export { setNextcloudTalkRuntime as n, getNextcloudTalkRuntime as t };
