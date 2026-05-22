import "./file-lock-BhZ1fIVv.js";
import { t as createPluginRuntimeStore } from "./runtime-store-Ck0e4Li2.js";
import "./channel-policy-C9e05gYV.js";
import "./inbound-reply-dispatch-BCFofElq.js";
import "./outbound-media-DmYMB_CE.js";
import "./ssrf-runtime-Dz3vPG0b.js";
import "./media-runtime-CsDiyKfD.js";
import "./text-chunking-BG62trjr.js";
import "./channel-status-DsH1v7Er.js";
import "./channel-lifecycle-CHgOUFue.js";
import "./channel-message-CZxSDSxY.js";
import "./channel-pairing-qm6lMmPH.js";
import "./channel-targets-q9H6dfiO.js";
import "./webhook-ingress-0IXKcfHg.js";
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime, tryGetRuntime: getOptionalMSTeamsRuntime } = createPluginRuntimeStore({
	pluginId: "msteams",
	errorMessage: "MSTeams runtime not initialized"
});
//#endregion
export { getOptionalMSTeamsRuntime as n, setMSTeamsRuntime as r, getMSTeamsRuntime as t };
