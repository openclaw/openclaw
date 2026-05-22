import "./file-lock-BhZ1fIVv.js";
import { t as createPluginRuntimeStore } from "./runtime-store-Ck0e4Li2.js";
import "./channel-policy-CMWVILyR.js";
import "./inbound-reply-dispatch-CbVPkqLX.js";
import "./outbound-media-D_zXhfL3.js";
import "./ssrf-runtime-DiZYIPIC.js";
import "./media-runtime-eri84b_Q.js";
import "./text-chunking-CfgOiEjf.js";
import "./channel-status-DYYgC8Iv.js";
import "./channel-lifecycle-BR9KkA_z.js";
import "./channel-message-CBQ4P6FK.js";
import "./channel-pairing-Dn50-hnB.js";
import "./channel-targets-BzpLJobg.js";
import "./webhook-ingress-CdKNG8ep.js";
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime, tryGetRuntime: getOptionalMSTeamsRuntime } = createPluginRuntimeStore({
	pluginId: "msteams",
	errorMessage: "MSTeams runtime not initialized"
});
//#endregion
export { getOptionalMSTeamsRuntime as n, setMSTeamsRuntime as r, getMSTeamsRuntime as t };
