import { t as createPluginRuntimeStore } from "./runtime-store-Gsztj7De.js";
import "./outbound-media-3GKBi6ht.js";
import "./ssrf-runtime-CkUGpkoc.js";
import "./media-runtime-VIdlgue-.js";
import "./channel-status-BOptdune.js";
import "./bundled-channel-config-schema-DJEBpx_I.js";
import "./channel-config-primitives-C69ajkJh.js";
import "./channel-actions-BZNPyiTu.js";
import "./channel-feedback-CLn-5I0_.js";
import "./channel-inbound-ybWqytWq.js";
import "./channel-lifecycle-DKl5ZvEM.js";
import "./channel-message-DLRlnHTh.js";
import "./channel-pairing-DE1ZGqNp.js";
import "./webhook-request-guards-DsJn4zAu.js";
import "./webhook-targets-CpeOvDAB.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
