import { t as createPluginRuntimeStore } from "../../runtime-store-D2rbMekf.js";
import "../../channel-policy-5FBdjNP7.js";
import "../../channel-pairing-BI_ZJIJ_.js";
import "../../inbound-reply-dispatch-B0ZjYKzs.js";
import "../../ssrf-runtime-BGM8nkUl.js";
//#region extensions/nextcloud-talk/src/runtime.ts
const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } = createPluginRuntimeStore({
	pluginId: "nextcloud-talk",
	errorMessage: "Nextcloud Talk runtime not initialized"
});
//#endregion
export { setNextcloudTalkRuntime as n, getNextcloudTalkRuntime as t };
