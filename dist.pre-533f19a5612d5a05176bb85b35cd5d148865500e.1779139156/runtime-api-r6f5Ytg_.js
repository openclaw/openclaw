import { t as createPluginRuntimeStore } from "./runtime-store-BPbfSxdB.js";
import "./outbound-media-9Phqv2eN.js";
import "./ssrf-runtime-R6sAwobj.js";
import "./media-runtime-C_YRRJZQ.js";
import "./text-chunking-CQ6uz2HY.js";
import "./channel-status-C1bs_3mh.js";
import "./bundled-channel-config-schema-CaAok3C8.js";
import "./channel-config-primitives-B_8yIkTf.js";
import "./channel-actions-Db6K5Nyn.js";
import "./channel-feedback-CB-25Gnb.js";
import "./channel-inbound-gqHdFPFM.js";
import "./channel-lifecycle-DlhEpK_q.js";
import "./channel-message-De31klp8.js";
import "./channel-pairing-DuptReVT.js";
import "./webhook-ingress-B9ojpPKq.js";
import "./webhook-request-guards-Biv2YHZA.js";
import "./webhook-targets-CJH9JgRq.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
