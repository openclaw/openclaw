import { t as createPluginRuntimeStore } from "./runtime-store-D7S_cOrU.js";
import "./channel-policy-LhuEsRNm.js";
import "./outbound-media-B1baRGuP.js";
import "./ssrf-runtime-CNU9UpXf.js";
import "./media-runtime-Dd0DSUkR.js";
import "./channel-status-O4BFybJX.js";
import "./bundled-channel-config-schema-CzWz41k6.js";
import "./channel-config-primitives-BBuHhERX.js";
import "./channel-actions-D67Km9Lw.js";
import "./channel-feedback-DKlTzRsv.js";
import "./channel-inbound-DhPWe8TR.js";
import "./channel-lifecycle--1d0wYjm.js";
import "./channel-message-BlSItCoN.js";
import "./channel-pairing-SGLHqNpe.js";
import "./webhook-request-guards-9eJSCy3Q.js";
import "./webhook-targets-BLsP2QIz.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
