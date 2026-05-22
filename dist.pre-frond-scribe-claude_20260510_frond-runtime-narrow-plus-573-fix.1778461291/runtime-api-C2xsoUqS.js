import "./file-lock-ByXauwSI.js";
import { t as createPluginRuntimeStore } from "./runtime-store-Cg9cOb9V.js";
import "./channel-policy-BLtDHk3I.js";
import "./inbound-reply-dispatch-DdI0tXa7.js";
import "./outbound-media-D5gVno6y.js";
import "./ssrf-runtime-BdcRu7L4.js";
import "./media-runtime-DMdnxXjU.js";
import "./channel-status-DqKjqAvf.js";
import "./channel-lifecycle-CgCVCHY8.js";
import "./channel-message-Bzk-dIXe.js";
import "./channel-pairing-DX2KqVMh.js";
import "./channel-targets-B5ZA5Yem.js";
import "./webhook-ingress-BK9PCoig.js";
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime, tryGetRuntime: getOptionalMSTeamsRuntime } = createPluginRuntimeStore({
	pluginId: "msteams",
	errorMessage: "MSTeams runtime not initialized"
});
//#endregion
export { getOptionalMSTeamsRuntime as n, setMSTeamsRuntime as r, getMSTeamsRuntime as t };
