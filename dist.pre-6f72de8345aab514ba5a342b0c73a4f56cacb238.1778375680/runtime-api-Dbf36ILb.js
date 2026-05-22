import "./file-lock-CuGrv6zV.js";
import { t as createPluginRuntimeStore } from "./runtime-store-D7S_cOrU.js";
import "./channel-policy-LhuEsRNm.js";
import "./inbound-reply-dispatch-2hN8f3ia.js";
import "./outbound-media-B1baRGuP.js";
import "./ssrf-runtime-CNU9UpXf.js";
import "./media-runtime-Dd0DSUkR.js";
import "./channel-status-O4BFybJX.js";
import "./channel-lifecycle--1d0wYjm.js";
import "./channel-message-BlSItCoN.js";
import "./channel-pairing-SGLHqNpe.js";
import "./channel-targets-BxEJN6Om.js";
import "./webhook-ingress-C-mKAfe0.js";
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime, tryGetRuntime: getOptionalMSTeamsRuntime } = createPluginRuntimeStore({
	pluginId: "msteams",
	errorMessage: "MSTeams runtime not initialized"
});
//#endregion
export { getOptionalMSTeamsRuntime as n, setMSTeamsRuntime as r, getMSTeamsRuntime as t };
