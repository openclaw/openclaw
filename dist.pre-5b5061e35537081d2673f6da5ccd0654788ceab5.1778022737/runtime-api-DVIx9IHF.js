import "./channel-reply-pipeline-o-LATR-A.js";
import { t as createPluginRuntimeStore } from "./runtime-store-BToSvHpc.js";
import "./channel-policy-CrpCRRGP.js";
import "./channel-pairing-HNgb0OrQ.js";
import "./webhook-request-guards-CfdZlct7.js";
import "./webhook-targets-ByhBLZIm.js";
import "./outbound-media-BpXQc5ok.js";
import "./ssrf-runtime-B3HHI4NS.js";
import "./media-runtime-5rxXL-Os.js";
import "./channel-status-be0NZxcV.js";
import "./bundled-channel-config-schema-BABJdEcd.js";
import "./channel-config-primitives-DtKw-oDC.js";
import "./channel-actions-Lt3Lc2lg.js";
import "./channel-feedback-BC9FQHoQ.js";
import "./channel-inbound-Q8v-czKv.js";
import "./channel-lifecycle-ky0xWT7L.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
