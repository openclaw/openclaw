import "./file-lock-BtJ4erhv.js";
import { t as createPluginRuntimeStore } from "./runtime-store-C20iH_sr.js";
import "./channel-policy-DxkaLzbh.js";
import "./inbound-reply-dispatch-CgbBvKBx.js";
import "./outbound-media-CIjDAg6T.js";
import "./ssrf-runtime-BxiaPFE4.js";
import "./media-runtime-Bkhg9eNT.js";
import "./text-chunking-CkhUMyQF.js";
import "./channel-status-Dj8mUppJ.js";
import "./channel-lifecycle-RRGzPhvi.js";
import "./channel-message-LSizNOBL.js";
import "./channel-pairing-mMLW1oX3.js";
import "./channel-targets-DK8s-7Iv.js";
import "./webhook-ingress-DFQxlX68.js";
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime, tryGetRuntime: getOptionalMSTeamsRuntime } = createPluginRuntimeStore({
	pluginId: "msteams",
	errorMessage: "MSTeams runtime not initialized"
});
//#endregion
export { getOptionalMSTeamsRuntime as n, setMSTeamsRuntime as r, getMSTeamsRuntime as t };
