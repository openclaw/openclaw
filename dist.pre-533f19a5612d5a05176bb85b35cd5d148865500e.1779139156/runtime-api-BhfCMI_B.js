import "./file-lock-BhZ1fIVv.js";
import { t as createPluginRuntimeStore } from "./runtime-store-BPbfSxdB.js";
import "./channel-policy-1pwdDcv-.js";
import "./inbound-reply-dispatch-DYK_l4p8.js";
import "./outbound-media-9Phqv2eN.js";
import "./ssrf-runtime-R6sAwobj.js";
import "./media-runtime-C_YRRJZQ.js";
import "./text-chunking-CQ6uz2HY.js";
import "./channel-status-C1bs_3mh.js";
import "./channel-lifecycle-DlhEpK_q.js";
import "./channel-message-De31klp8.js";
import "./channel-pairing-DuptReVT.js";
import "./channel-targets-CPjzZQAI.js";
import "./webhook-ingress-B9ojpPKq.js";
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime, tryGetRuntime: getOptionalMSTeamsRuntime } = createPluginRuntimeStore({
	pluginId: "msteams",
	errorMessage: "MSTeams runtime not initialized"
});
//#endregion
export { getOptionalMSTeamsRuntime as n, setMSTeamsRuntime as r, getMSTeamsRuntime as t };
