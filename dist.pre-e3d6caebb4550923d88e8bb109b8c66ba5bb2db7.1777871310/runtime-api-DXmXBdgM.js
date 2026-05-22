import { t as createPluginRuntimeStore } from "./runtime-store-BToSvHpc.js";
import "./channel-policy-CrpCRRGP.js";
import "./channel-pairing-HNgb0OrQ.js";
import "./inbound-reply-dispatch-N--Oj9Dq.js";
import "./ssrf-runtime-B3HHI4NS.js";
//#region extensions/nextcloud-talk/src/runtime.ts
const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } = createPluginRuntimeStore({
	pluginId: "nextcloud-talk",
	errorMessage: "Nextcloud Talk runtime not initialized"
});
//#endregion
export { setNextcloudTalkRuntime as n, getNextcloudTalkRuntime as t };
