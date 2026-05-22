import { t as createPluginRuntimeStore } from "./runtime-store-CSfjApnh.js";
import "./outbound-media-CGqnlISR.js";
import "./ssrf-runtime-tmjiuH_f.js";
import "./media-runtime--1rTkfXw.js";
import "./text-chunking-DjlMd8vL.js";
import "./channel-status-D8Np2Hnc.js";
import "./bundled-channel-config-schema-CwSmAESn.js";
import "./channel-config-primitives-gDI3pY-0.js";
import "./channel-actions-qudH-xs4.js";
import "./channel-feedback-vFdCrcLe.js";
import "./channel-inbound-wPx3BFYa.js";
import "./channel-lifecycle-ByfcF3zQ.js";
import "./channel-message-CnGoBBDG.js";
import "./channel-pairing-CNTI8ttR.js";
import "./webhook-ingress-DrIiMsDe.js";
import "./webhook-request-guards-B1TG1dWR.js";
import "./webhook-targets-Tp84E9dH.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
