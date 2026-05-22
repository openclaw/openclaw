import { t as createPluginRuntimeStore } from "./runtime-store-Ck0e4Li2.js";
import "./outbound-media-BsvdAQZZ.js";
import "./ssrf-runtime-Dz3vPG0b.js";
import "./media-runtime-CBarHxr2.js";
import "./text-chunking-C9lv4IbI.js";
import "./channel-status-DsH1v7Er.js";
import "./bundled-channel-config-schema-C2N3DZvi.js";
import "./channel-config-primitives-C8zX7Cax.js";
import "./channel-actions-BoEvPE91.js";
import "./channel-feedback-D2osYju-.js";
import "./channel-inbound-DbgdptLr.js";
import "./channel-lifecycle-CHgOUFue.js";
import "./channel-message-BH4fSx9l.js";
import "./channel-pairing-qm6lMmPH.js";
import "./webhook-ingress-BwjzWW-s.js";
import "./webhook-request-guards-Cu-R_bi1.js";
import "./webhook-targets-Bq_G_gET.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
