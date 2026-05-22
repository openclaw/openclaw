import "./file-lock-nRpXFYTJ.js";
import { t as createPluginRuntimeStore } from "./runtime-store-CSfjApnh.js";
import "./channel-policy-Cgysik1Z.js";
import "./inbound-reply-dispatch-fHDVpkgf.js";
import "./outbound-media-CGqnlISR.js";
import "./ssrf-runtime-tmjiuH_f.js";
import "./media-runtime--1rTkfXw.js";
import "./text-chunking-DjlMd8vL.js";
import "./channel-status-D8Np2Hnc.js";
import "./channel-lifecycle-ByfcF3zQ.js";
import "./channel-message-CnGoBBDG.js";
import "./channel-pairing-CNTI8ttR.js";
import "./channel-targets-D74S8uWT.js";
import "./webhook-ingress-DrIiMsDe.js";
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime, tryGetRuntime: getOptionalMSTeamsRuntime } = createPluginRuntimeStore({
	pluginId: "msteams",
	errorMessage: "MSTeams runtime not initialized"
});
//#endregion
export { getOptionalMSTeamsRuntime as n, setMSTeamsRuntime as r, getMSTeamsRuntime as t };
