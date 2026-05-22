import "./file-lock-BtJ4erhv.js";
import { t as createPluginRuntimeStore } from "./runtime-store-C20iH_sr.js";
import "./channel-policy-fOi0H-_f.js";
import "./inbound-reply-dispatch-CAvZUxTt.js";
import "./outbound-media-CePOg7-p.js";
import "./ssrf-runtime-CJrKqHnq.js";
import "./media-runtime-CiCyW7ch.js";
import "./text-chunking-CkhUMyQF.js";
import "./channel-status-Dj8mUppJ.js";
import "./channel-lifecycle-RRGzPhvi.js";
import "./channel-message-CBzgQfUC.js";
import "./channel-pairing-BkOWWNUn.js";
import "./channel-targets-CAdEzQjz.js";
import "./webhook-ingress-CP6PQk7T.js";
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime, tryGetRuntime: getOptionalMSTeamsRuntime } = createPluginRuntimeStore({
	pluginId: "msteams",
	errorMessage: "MSTeams runtime not initialized"
});
//#endregion
export { getOptionalMSTeamsRuntime as n, setMSTeamsRuntime as r, getMSTeamsRuntime as t };
