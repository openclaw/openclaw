import { t as createPluginRuntimeStore } from "./runtime-store-Cezm5nT2.js";
import "./outbound-media-GCXqMq5T.js";
import "./ssrf-runtime-BxfNsut3.js";
import "./media-runtime-C5IoNmJM.js";
import "./text-chunking-B1eCf5mf.js";
import "./channel-status-pmRGSI7K.js";
import "./bundled-channel-config-schema-ThEmc3Nk.js";
import "./channel-config-primitives-C3bCZYk8.js";
import "./channel-actions-t0R77jqp.js";
import "./channel-feedback-Dv79lZRY.js";
import "./channel-inbound-B92Mr0-p.js";
import "./channel-lifecycle-Bw0QrZJX.js";
import "./channel-message-CO23hUpq.js";
import "./channel-pairing-BQ9lyBd_.js";
import "./webhook-ingress-bP21RBa9.js";
import "./webhook-request-guards-CCw6z8fc.js";
import "./webhook-targets-CZD1wkiF.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
