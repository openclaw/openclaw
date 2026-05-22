import { t as createPluginRuntimeStore } from "./runtime-store-C20iH_sr.js";
import "./outbound-media-CIjDAg6T.js";
import "./ssrf-runtime-BxiaPFE4.js";
import "./media-runtime-Bkhg9eNT.js";
import "./text-chunking-CkhUMyQF.js";
import "./channel-status-Dj8mUppJ.js";
import "./bundled-channel-config-schema-CXP09KHC.js";
import "./channel-config-primitives-HriyEVZX.js";
import "./channel-actions-CJOO_Y7F.js";
import "./channel-feedback-BZVN4ueZ.js";
import "./channel-inbound-CdgMukFs.js";
import "./channel-lifecycle-RRGzPhvi.js";
import "./channel-message-LSizNOBL.js";
import "./channel-pairing-mMLW1oX3.js";
import "./webhook-ingress-DFQxlX68.js";
import "./webhook-request-guards-DtBv-STT.js";
import "./webhook-targets-DhZ9_Zr5.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
