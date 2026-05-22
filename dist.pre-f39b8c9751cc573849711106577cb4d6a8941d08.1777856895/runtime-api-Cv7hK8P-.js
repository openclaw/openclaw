import { t as createPluginRuntimeStore } from "./runtime-store-zhyGrZKn.js";
import "./channel-policy-B2y9ydxC.js";
import "./channel-pairing-UfwPeD2I.js";
import "./inbound-reply-dispatch-B6e9wgzk.js";
import "./ssrf-runtime-Bozc6A2_.js";
//#region extensions/nextcloud-talk/src/runtime.ts
const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } = createPluginRuntimeStore({
	pluginId: "nextcloud-talk",
	errorMessage: "Nextcloud Talk runtime not initialized"
});
//#endregion
export { setNextcloudTalkRuntime as n, getNextcloudTalkRuntime as t };
