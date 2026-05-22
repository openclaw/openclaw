import "./file-lock-CCOJxG89.js";
import { t as createPluginRuntimeStore } from "./runtime-store-DpA2UZdL.js";
import "./channel-policy-BY0FQ3rn.js";
import "./inbound-reply-dispatch-Dvv2aukT.js";
import "./outbound-media-D2Ts68c3.js";
import "./ssrf-runtime-c_uf32me.js";
import "./media-runtime--x8BthNJ.js";
import "./text-chunking-B_k4cuS8.js";
import "./channel-status-CkID1ohH.js";
import "./channel-lifecycle-i2ac0Ks1.js";
import "./channel-message-DSuZIuT2.js";
import "./channel-pairing-BmI87Ctq.js";
import "./channel-targets-DReoi5sx.js";
import "./webhook-ingress-CrW8HXSM.js";
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime, tryGetRuntime: getOptionalMSTeamsRuntime } = createPluginRuntimeStore({
	pluginId: "msteams",
	errorMessage: "MSTeams runtime not initialized"
});
//#endregion
export { getOptionalMSTeamsRuntime as n, setMSTeamsRuntime as r, getMSTeamsRuntime as t };
