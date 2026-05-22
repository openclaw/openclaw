import { t as createPluginRuntimeStore } from "./runtime-store-2ORR7yfg.js";
import "./outbound-media-dSy4I5H5.js";
import "./ssrf-runtime-BDi9tXcb.js";
import "./media-runtime-BqjAMS-d.js";
import "./text-chunking-DZnxKaUJ.js";
import "./channel-status-CoOBYmoa.js";
import "./bundled-channel-config-schema-vMxbl2Zb.js";
import "./channel-config-primitives-CDf1FyUo.js";
import "./channel-actions-DRZl_TLC.js";
import "./channel-feedback-B40ZuVnV.js";
import "./channel-inbound-Cm_T7wtn.js";
import "./channel-lifecycle-qyrUoA-W.js";
import "./channel-message-CHkrbl6L.js";
import "./channel-pairing-9_fRH2pa.js";
import "./webhook-ingress-Da7h5Mdh.js";
import "./webhook-request-guards-Bb2b6gZf.js";
import "./webhook-targets-De-zmEVk.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
