import { t as createPluginRuntimeStore } from "./runtime-store-LLLxGXsu.js";
import "./ssrf-runtime-CaWyYFbv.js";
import "./channel-message-B1-LA4aR.js";
import "./channel-pairing-BR8BiOoy.js";
//#region extensions/nextcloud-talk/src/runtime.ts
const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } = createPluginRuntimeStore({
	pluginId: "nextcloud-talk",
	errorMessage: "Nextcloud Talk runtime not initialized"
});
//#endregion
export { setNextcloudTalkRuntime as n, getNextcloudTalkRuntime as t };
