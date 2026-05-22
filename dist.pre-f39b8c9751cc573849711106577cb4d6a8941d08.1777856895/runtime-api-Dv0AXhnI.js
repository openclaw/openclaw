import "./channel-reply-pipeline-CLWAtKLB.js";
import { t as createPluginRuntimeStore } from "./runtime-store-zhyGrZKn.js";
import "./channel-policy-B2y9ydxC.js";
import "./channel-pairing-UfwPeD2I.js";
import "./webhook-request-guards-CXAa0Cdn.js";
import "./webhook-targets-DCbxM9jo.js";
import "./outbound-media-C5Seu7rr.js";
import "./ssrf-runtime-Bozc6A2_.js";
import "./media-runtime-BFyCHDx4.js";
import "./channel-status-C5TtpNEM.js";
import "./bundled-channel-config-schema-DRT5DA4i.js";
import "./channel-config-primitives-C__G3q35.js";
import "./channel-actions-CjoBRlW1.js";
import "./channel-feedback-DualLpT4.js";
import "./channel-inbound-D0ndIWsm.js";
import "./channel-lifecycle-DxmCzu5Q.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
