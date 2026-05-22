import { t as createPluginRuntimeStore } from "./runtime-store-Ck0e4Li2.js";
import "./outbound-media-DmYMB_CE.js";
import "./ssrf-runtime-Dz3vPG0b.js";
import "./media-runtime-CsDiyKfD.js";
import "./text-chunking-BG62trjr.js";
import "./channel-status-DsH1v7Er.js";
import "./bundled-channel-config-schema-DI3MKmEu.js";
import "./channel-config-primitives-C8zX7Cax.js";
import "./channel-actions-BoEvPE91.js";
import "./channel-feedback-D2osYju-.js";
import "./channel-inbound-D1_2OGTe.js";
import "./channel-lifecycle-CHgOUFue.js";
import "./channel-message-CZxSDSxY.js";
import "./channel-pairing-qm6lMmPH.js";
import "./webhook-ingress-0IXKcfHg.js";
import "./webhook-request-guards-Cu-R_bi1.js";
import "./webhook-targets-BkKPcZgs.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
