import { t as createPluginRuntimeStore } from "../../runtime-store-67Vxx2iX.js";
import "../../channel-policy-BdLhwf7S.js";
import "../../channel-pairing-DWcD6g9Y.js";
import "../../inbound-reply-dispatch-CLFxPB1h.js";
import "../../ssrf-runtime-Cup62pw7.js";
//#region extensions/nextcloud-talk/src/runtime.ts
const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } = createPluginRuntimeStore({
	pluginId: "nextcloud-talk",
	errorMessage: "Nextcloud Talk runtime not initialized"
});
//#endregion
export { setNextcloudTalkRuntime as n, getNextcloudTalkRuntime as t };
