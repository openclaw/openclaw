import { t as createPluginRuntimeStore } from "./runtime-store-LLLxGXsu.js";
import "./outbound-media-B7ZnVQHz.js";
import "./ssrf-runtime-CaWyYFbv.js";
import "./media-runtime-DeuscnM0.js";
import "./text-chunking-WnXdOF_7.js";
import "./channel-status-DWmZgOx2.js";
import "./bundled-channel-config-schema-Du35lcio.js";
import "./channel-config-primitives-BXzdGeib.js";
import "./channel-actions-CKUTFVVS.js";
import "./channel-feedback-CYwPbHFe.js";
import "./channel-inbound-DV5I9l4s.js";
import "./channel-lifecycle-BdkDlmFA.js";
import "./channel-message-B1-LA4aR.js";
import "./channel-pairing-BR8BiOoy.js";
import "./webhook-ingress-ChYTsoY4.js";
import "./webhook-request-guards-BvO1WH4g.js";
import "./webhook-targets-CVAibszY.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
