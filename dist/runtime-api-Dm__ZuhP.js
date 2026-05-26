import { t as createPluginRuntimeStore } from "./runtime-store-Cigg_Veg.js";
import "./outbound-media-BTsScThx.js";
import "./ssrf-runtime-B7YsbRmp.js";
import "./media-runtime-DWh6m_8p.js";
import "./text-chunking-3_9rfiI8.js";
import "./channel-status-DQzE7laT.js";
import "./bundled-channel-config-schema-B1433kYy.js";
import "./channel-config-primitives-CbQ414E1.js";
import "./channel-actions-BDOLVWJN.js";
import "./channel-feedback-B9Irbkxa.js";
import "./channel-inbound-DuNiLVQs.js";
import "./channel-lifecycle-BrKB268B.js";
import "./channel-message-CmG6T1ry.js";
import "./channel-pairing--8umY0wm.js";
import "./webhook-ingress-T_7zkgKq.js";
import "./webhook-request-guards-CHYlKcg-.js";
import "./webhook-targets-Bq1eDk6l.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
