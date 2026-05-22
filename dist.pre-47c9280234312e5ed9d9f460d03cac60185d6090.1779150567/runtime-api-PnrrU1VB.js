import { t as createPluginRuntimeStore } from "./runtime-store-Cyf2sWjo.js";
import "./outbound-media-CZcIIgFS.js";
import "./ssrf-runtime-DjGTjYDE.js";
import "./media-runtime-0W8KVR3F.js";
import "./text-chunking-DYAKLfbn.js";
import "./channel-status-C--eIG63.js";
import "./bundled-channel-config-schema-C4yPoZ3d.js";
import "./channel-config-primitives-CMeVfWFm.js";
import "./channel-actions-BGsl31yM.js";
import "./channel-feedback-DHgiW2R9.js";
import "./channel-inbound-BtCbLcap.js";
import "./channel-lifecycle-X5Spm4Bu.js";
import "./channel-message-BRLoIsXC.js";
import "./channel-pairing-D8fLvBHT.js";
import "./webhook-ingress-Bt0y0Iur.js";
import "./webhook-request-guards-BK_FbkXh.js";
import "./webhook-targets-B75fL65M.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
