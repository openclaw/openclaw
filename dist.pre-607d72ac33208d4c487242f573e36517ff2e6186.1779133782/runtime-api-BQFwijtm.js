import "./file-lock-BhZ1fIVv.js";
import { t as createPluginRuntimeStore } from "./runtime-store-Ck0e4Li2.js";
import "./channel-policy-C9e05gYV.js";
import "./inbound-reply-dispatch-DITW56UX.js";
import "./outbound-media-BsvdAQZZ.js";
import "./ssrf-runtime-Dz3vPG0b.js";
import "./media-runtime-CBarHxr2.js";
import "./text-chunking-C9lv4IbI.js";
import "./channel-status-DsH1v7Er.js";
import "./channel-lifecycle-CHgOUFue.js";
import "./channel-message-BH4fSx9l.js";
import "./channel-pairing-qm6lMmPH.js";
import "./channel-targets-q9H6dfiO.js";
import "./webhook-ingress-BwjzWW-s.js";
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime, tryGetRuntime: getOptionalMSTeamsRuntime } = createPluginRuntimeStore({
	pluginId: "msteams",
	errorMessage: "MSTeams runtime not initialized"
});
//#endregion
export { getOptionalMSTeamsRuntime as n, setMSTeamsRuntime as r, getMSTeamsRuntime as t };
