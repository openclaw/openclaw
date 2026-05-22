import "../../channel-reply-pipeline-DR9vcaJj.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-D2rbMekf.js";
import "../../channel-policy-5FBdjNP7.js";
import "../../channel-pairing-BI_ZJIJ_.js";
import "../../webhook-request-guards-Rxy-X5bK.js";
import "../../webhook-targets-Cg3BzlhQ.js";
import "../../outbound-media-ggFx4c0j.js";
import "../../ssrf-runtime-BGM8nkUl.js";
import "../../media-runtime-B3sgGdPE.js";
import "../../channel-status-CGjVWC2r.js";
import "../../bundled-channel-config-schema-B0meCrg2.js";
import "../../channel-config-primitives-DO6QJ-Wa.js";
import "../../channel-actions-eIOtDEsn.js";
import "../../channel-feedback-DLgsokgN.js";
import "../../channel-inbound-C8PftHv8.js";
import "../../channel-lifecycle-D27EMvrw.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
