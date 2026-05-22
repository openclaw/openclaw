import "./file-lock-DcubmIcx.js";
import { t as createPluginRuntimeStore } from "./runtime-store-Cezm5nT2.js";
import "./channel-policy-CGLwpNYQ.js";
import "./inbound-reply-dispatch-Ce4SAn4V.js";
import "./outbound-media-BiKIdmB2.js";
import "./ssrf-runtime-BUdcoJws.js";
import "./media-runtime-BRqBxHRo.js";
import "./text-chunking-DAvRGrET.js";
import "./channel-status-Bsp7cc4O.js";
import "./channel-lifecycle-BRrbD5sB.js";
import "./channel-message-D2DSarag.js";
import "./channel-pairing-CtkLWg1v.js";
import "./channel-targets-fpiJVww1.js";
import "./webhook-ingress-BUa-8a2k.js";
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime, tryGetRuntime: getOptionalMSTeamsRuntime } = createPluginRuntimeStore({
	pluginId: "msteams",
	errorMessage: "MSTeams runtime not initialized"
});
//#endregion
export { getOptionalMSTeamsRuntime as n, setMSTeamsRuntime as r, getMSTeamsRuntime as t };
