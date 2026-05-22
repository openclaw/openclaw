import "../../channel-reply-pipeline-ChCtYK0Y.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-67Vxx2iX.js";
import "../../channel-policy-BdLhwf7S.js";
import "../../channel-pairing-DWcD6g9Y.js";
import "../../webhook-request-guards-CLob3mYw.js";
import "../../webhook-targets-qzHIc_0-.js";
import "../../outbound-media-DDOz50q_.js";
import "../../ssrf-runtime-Cup62pw7.js";
import "../../media-runtime-Doi16sSJ.js";
import "../../channel-status-D_w9jtCo.js";
import "../../bundled-channel-config-schema-DcMPDeA7.js";
import "../../channel-config-primitives-CvAE8ZSi.js";
import "../../channel-actions-B40ZTXp-.js";
import "../../channel-feedback-CJVY1O_2.js";
import "../../channel-inbound-CtPTvcjp.js";
import "../../channel-lifecycle-3hHWoDSN.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
