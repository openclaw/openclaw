import { t as createPluginRuntimeStore } from "./runtime-store-Cezm5nT2.js";
import "./outbound-media-vAhpTcTX.js";
import "./ssrf-runtime-Db7Y0wil.js";
import "./media-runtime-D2Qs-Ei3.js";
import "./text-chunking-CVvpFHIe.js";
import "./channel-status-CgLm1zs_.js";
import "./bundled-channel-config-schema-X2kV9Vl4.js";
import "./channel-config-primitives-DahWabED.js";
import "./channel-actions-BpDKr8Kj.js";
import "./channel-feedback-CC-aAeFq.js";
import "./channel-inbound-D0WUQiUb.js";
import "./channel-lifecycle-zAmglhsU.js";
import "./channel-message-DkD03ToM.js";
import "./channel-pairing-C53hVVH8.js";
import "./webhook-ingress-gd9GGtpF.js";
import "./webhook-request-guards-2eUfWk3O.js";
import "./webhook-targets-Cly6wTxT.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
