import "./file-lock-D_-jJPgc.js";
import "./channel-reply-pipeline-o-LATR-A.js";
import { t as createPluginRuntimeStore } from "./runtime-store-BToSvHpc.js";
import "./channel-policy-CrpCRRGP.js";
import "./channel-targets-_x-Xs-UL.js";
import "./channel-pairing-HNgb0OrQ.js";
import "./webhook-ingress-ClPA1a_D.js";
import "./inbound-reply-dispatch-BNcsRuO0.js";
import "./outbound-media-BpXQc5ok.js";
import "./ssrf-runtime-B3HHI4NS.js";
import "./media-runtime-5rxXL-Os.js";
import "./channel-status-be0NZxcV.js";
import "./channel-lifecycle-ky0xWT7L.js";
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime } = createPluginRuntimeStore({
	pluginId: "msteams",
	errorMessage: "MSTeams runtime not initialized"
});
//#endregion
export { setMSTeamsRuntime as n, getMSTeamsRuntime as t };
