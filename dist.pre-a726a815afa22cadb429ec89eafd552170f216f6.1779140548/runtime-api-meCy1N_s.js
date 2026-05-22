import { t as createPluginRuntimeStore } from "./runtime-store-Cyf2sWjo.js";
import "./ssrf-runtime-DjGTjYDE.js";
import "./channel-message-BRLoIsXC.js";
import "./channel-pairing-D8fLvBHT.js";
//#region extensions/nextcloud-talk/src/runtime.ts
const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } = createPluginRuntimeStore({
	pluginId: "nextcloud-talk",
	errorMessage: "Nextcloud Talk runtime not initialized"
});
//#endregion
export { setNextcloudTalkRuntime as n, getNextcloudTalkRuntime as t };
