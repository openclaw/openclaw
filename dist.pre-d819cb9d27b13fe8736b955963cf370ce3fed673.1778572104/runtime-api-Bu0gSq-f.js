import { t as createPluginRuntimeStore } from "./runtime-store-C20iH_sr.js";
import "./outbound-media-CePOg7-p.js";
import "./ssrf-runtime-CJrKqHnq.js";
import "./media-runtime-CiCyW7ch.js";
import "./text-chunking-CkhUMyQF.js";
import "./channel-status-Dj8mUppJ.js";
import "./bundled-channel-config-schema-CXP09KHC.js";
import "./channel-config-primitives-HriyEVZX.js";
import "./channel-actions-DlnlmoXy.js";
import "./channel-feedback-D-0drMkb.js";
import "./channel-inbound-CknlNatI.js";
import "./channel-lifecycle-RRGzPhvi.js";
import "./channel-message-CBzgQfUC.js";
import "./channel-pairing-BkOWWNUn.js";
import "./webhook-ingress-CP6PQk7T.js";
import "./webhook-request-guards-DtBv-STT.js";
import "./webhook-targets-_Y7xn4Gg.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
