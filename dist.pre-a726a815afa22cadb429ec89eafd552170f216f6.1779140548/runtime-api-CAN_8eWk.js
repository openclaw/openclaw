import "./file-lock-BhZ1fIVv.js";
import { t as createPluginRuntimeStore } from "./runtime-store-Cyf2sWjo.js";
import "./channel-policy-BxwNlpKd.js";
import "./inbound-reply-dispatch-xxc7li99.js";
import "./outbound-media-CZcIIgFS.js";
import "./ssrf-runtime-DjGTjYDE.js";
import "./media-runtime-0W8KVR3F.js";
import "./text-chunking-DYAKLfbn.js";
import "./channel-status-C--eIG63.js";
import "./channel-lifecycle-X5Spm4Bu.js";
import "./channel-message-BRLoIsXC.js";
import "./channel-pairing-D8fLvBHT.js";
import "./channel-targets-Ds7tuswy.js";
import "./webhook-ingress-Bt0y0Iur.js";
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime, tryGetRuntime: getOptionalMSTeamsRuntime } = createPluginRuntimeStore({
	pluginId: "msteams",
	errorMessage: "MSTeams runtime not initialized"
});
//#endregion
export { getOptionalMSTeamsRuntime as n, setMSTeamsRuntime as r, getMSTeamsRuntime as t };
