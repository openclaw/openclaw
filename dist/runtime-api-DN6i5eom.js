import "./file-lock-D5OTq3qW.js";
import { t as createPluginRuntimeStore } from "./runtime-store-Cezm5nT2.js";
import "./channel-policy-pv8ZpZxj.js";
import "./inbound-reply-dispatch-Bi01ox5N.js";
import "./outbound-media-BwaTbAKd.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./media-runtime-BheBFFxc.js";
import "./text-chunking-C154U6-i.js";
import "./channel-status-pVVcmlap.js";
import "./channel-lifecycle-B7VOl7bW.js";
import "./channel-message-DMGbyII_.js";
import "./channel-pairing-N4dBc-K-.js";
import "./channel-targets-DLOcH73y.js";
import "./webhook-ingress-R0qMwT4u.js";
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime, tryGetRuntime: getOptionalMSTeamsRuntime } = createPluginRuntimeStore({
	pluginId: "msteams",
	errorMessage: "MSTeams runtime not initialized"
});
//#endregion
export { getOptionalMSTeamsRuntime as n, setMSTeamsRuntime as r, getMSTeamsRuntime as t };
