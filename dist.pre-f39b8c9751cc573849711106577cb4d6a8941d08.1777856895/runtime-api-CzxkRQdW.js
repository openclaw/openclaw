import "./file-lock-BAsPvsm7.js";
import "./channel-reply-pipeline-CLWAtKLB.js";
import { t as createPluginRuntimeStore } from "./runtime-store-zhyGrZKn.js";
import "./channel-policy-B2y9ydxC.js";
import "./channel-targets-DA4JCeBI.js";
import "./channel-pairing-UfwPeD2I.js";
import "./webhook-ingress-B0shdm5I.js";
import "./inbound-reply-dispatch-B6e9wgzk.js";
import "./outbound-media-C5Seu7rr.js";
import "./ssrf-runtime-Bozc6A2_.js";
import "./media-runtime-BFyCHDx4.js";
import "./channel-status-C5TtpNEM.js";
import "./channel-lifecycle-DxmCzu5Q.js";
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime } = createPluginRuntimeStore({
	pluginId: "msteams",
	errorMessage: "MSTeams runtime not initialized"
});
//#endregion
export { setMSTeamsRuntime as n, getMSTeamsRuntime as t };
