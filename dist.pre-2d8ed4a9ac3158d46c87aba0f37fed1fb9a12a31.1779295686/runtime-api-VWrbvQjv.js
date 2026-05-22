import { t as createPluginRuntimeStore } from "./runtime-store-MAmQRWGj.js";
import "./outbound-media-BCrmNTg6.js";
import "./ssrf-runtime-uB3Az6qX.js";
import "./media-runtime-B14sZn5Z.js";
import "./text-chunking-B1yt63di.js";
import "./channel-status-BrGRj_08.js";
import "./bundled-channel-config-schema-BcAkK-Ic.js";
import "./channel-config-primitives-D0dUPyfl.js";
import "./channel-actions-D-k0Jbqk.js";
import "./channel-feedback-CrpY_-Gx.js";
import "./channel-inbound-CKkxNoit.js";
import "./channel-lifecycle-EyUVuih4.js";
import "./channel-message-Ds8UNA42.js";
import "./channel-pairing-B7ONSWNj.js";
import "./webhook-ingress-C2a5a39Z.js";
import "./webhook-request-guards-CGK7RN1i.js";
import "./webhook-targets-Cyz4GvN7.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
