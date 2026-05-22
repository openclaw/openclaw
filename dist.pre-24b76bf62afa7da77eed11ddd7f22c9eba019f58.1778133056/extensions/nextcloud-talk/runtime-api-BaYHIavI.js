import { t as createPluginRuntimeStore } from "../../runtime-store-Wij_b93b.js";
import "../../channel-policy-CJIN_g7f.js";
import "../../channel-pairing-CWWMPhAh.js";
import "../../inbound-reply-dispatch-BCOdLV9x.js";
import "../../ssrf-runtime-BoUUJCOc.js";
//#region extensions/nextcloud-talk/src/runtime.ts
const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } = createPluginRuntimeStore({
	pluginId: "nextcloud-talk",
	errorMessage: "Nextcloud Talk runtime not initialized"
});
//#endregion
export { setNextcloudTalkRuntime as n, getNextcloudTalkRuntime as t };
