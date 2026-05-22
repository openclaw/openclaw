import "../../file-lock-CrMnB3Eo.js";
import "../../channel-reply-pipeline-ChCtYK0Y.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-67Vxx2iX.js";
import "../../channel-policy-BdLhwf7S.js";
import "../../channel-targets-c18sQnt-.js";
import "../../channel-pairing-DWcD6g9Y.js";
import "../../webhook-ingress-DvQM-_Ih.js";
import "../../inbound-reply-dispatch-CLFxPB1h.js";
import "../../outbound-media-DDOz50q_.js";
import "../../ssrf-runtime-Cup62pw7.js";
import "../../media-runtime-Doi16sSJ.js";
import "../../channel-status-D_w9jtCo.js";
import "../../channel-lifecycle-3hHWoDSN.js";
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime, tryGetRuntime: getOptionalMSTeamsRuntime } = createPluginRuntimeStore({
	pluginId: "msteams",
	errorMessage: "MSTeams runtime not initialized"
});
//#endregion
export { getOptionalMSTeamsRuntime as n, setMSTeamsRuntime as r, getMSTeamsRuntime as t };
