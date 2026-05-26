import { t as createPluginRuntimeStore } from "./runtime-store-Cezm5nT2.js";
import "./outbound-media-BwaTbAKd.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./media-runtime-BheBFFxc.js";
import "./text-chunking-C154U6-i.js";
import "./channel-status-pVVcmlap.js";
import "./bundled-channel-config-schema-CA36mrPs.js";
import "./channel-config-primitives-BKu_-glE.js";
import "./channel-actions-DMN7G5RZ.js";
import "./channel-feedback-Bn34MjYD.js";
import "./channel-inbound-C7GtKjtG.js";
import "./channel-lifecycle-B7VOl7bW.js";
import "./channel-message-DMGbyII_.js";
import "./channel-pairing-N4dBc-K-.js";
import "./webhook-ingress-R0qMwT4u.js";
import "./webhook-request-guards-iMi786D5.js";
import "./webhook-targets-gc0zD_lY.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
