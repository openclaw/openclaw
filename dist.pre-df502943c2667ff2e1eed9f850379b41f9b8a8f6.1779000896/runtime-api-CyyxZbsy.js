import { t as createPluginRuntimeStore } from "./runtime-store-DpA2UZdL.js";
import "./outbound-media-D2Ts68c3.js";
import "./ssrf-runtime-c_uf32me.js";
import "./media-runtime--x8BthNJ.js";
import "./text-chunking-B_k4cuS8.js";
import "./channel-status-CkID1ohH.js";
import "./bundled-channel-config-schema-DV8onDJE.js";
import "./channel-config-primitives-CfKQ7bi0.js";
import "./channel-actions-DjRn61Fp.js";
import "./channel-feedback-Bi7a6NZm.js";
import "./channel-inbound-cc5iPX0B.js";
import "./channel-lifecycle-i2ac0Ks1.js";
import "./channel-message-DSuZIuT2.js";
import "./channel-pairing-BmI87Ctq.js";
import "./webhook-ingress-CrW8HXSM.js";
import "./webhook-request-guards-BEvE6HvP.js";
import "./webhook-targets-Bqdh4Y2b.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
