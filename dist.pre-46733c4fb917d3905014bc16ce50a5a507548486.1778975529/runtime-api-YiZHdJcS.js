import { t as createPluginRuntimeStore } from "./runtime-store-CSfjApnh.js";
import "./outbound-media-ButoEKx2.js";
import "./ssrf-runtime-DPexcW9I.js";
import "./media-runtime-B6CavSZQ.js";
import "./text-chunking-BDDPJPB6.js";
import "./channel-status-7KUVffLE.js";
import "./bundled-channel-config-schema-CTX_dhcp.js";
import "./channel-config-primitives-Bs6nDifd.js";
import "./channel-actions-DPYm_-L9.js";
import "./channel-feedback-CnFUQ3Pd.js";
import "./channel-inbound-B4w33ytl.js";
import "./channel-lifecycle-BwwIv78-.js";
import "./channel-message-D8XpAab3.js";
import "./channel-pairing-DDbNNRH5.js";
import "./webhook-ingress-CNfu7BL2.js";
import "./webhook-request-guards-DGk58UgV.js";
import "./webhook-targets-CNkI7dLL.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
