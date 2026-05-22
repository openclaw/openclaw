import { t as createPluginRuntimeStore } from "./runtime-store-Cezm5nT2.js";
import "./outbound-media-BiKIdmB2.js";
import "./ssrf-runtime-BUdcoJws.js";
import "./media-runtime-BRqBxHRo.js";
import "./text-chunking-DAvRGrET.js";
import "./channel-status-Bsp7cc4O.js";
import "./bundled-channel-config-schema-DLot5wXA.js";
import "./channel-config-primitives-CB79qvcv.js";
import "./channel-actions-BBYevPTQ.js";
import "./channel-feedback-CvMYHjjc.js";
import "./channel-inbound-DogZfXBW.js";
import "./channel-lifecycle-BRrbD5sB.js";
import "./channel-message-D2DSarag.js";
import "./channel-pairing-CtkLWg1v.js";
import "./webhook-ingress-BUa-8a2k.js";
import "./webhook-request-guards-CCqlyfti.js";
import "./webhook-targets-DkaFZL9E.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
