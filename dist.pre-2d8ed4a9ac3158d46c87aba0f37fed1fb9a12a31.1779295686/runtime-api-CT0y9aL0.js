import "./file-lock-BhZ1fIVv.js";
import { t as createPluginRuntimeStore } from "./runtime-store-MAmQRWGj.js";
import "./channel-policy-Cpup5scq.js";
import "./inbound-reply-dispatch-DhZks1ig.js";
import "./outbound-media-BCrmNTg6.js";
import "./ssrf-runtime-uB3Az6qX.js";
import "./media-runtime-B14sZn5Z.js";
import "./text-chunking-B1yt63di.js";
import "./channel-status-BrGRj_08.js";
import "./channel-lifecycle-EyUVuih4.js";
import "./channel-message-Ds8UNA42.js";
import "./channel-pairing-B7ONSWNj.js";
import "./channel-targets--QWJui8x.js";
import "./webhook-ingress-C2a5a39Z.js";
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime, tryGetRuntime: getOptionalMSTeamsRuntime } = createPluginRuntimeStore({
	pluginId: "msteams",
	errorMessage: "MSTeams runtime not initialized"
});
//#endregion
export { getOptionalMSTeamsRuntime as n, setMSTeamsRuntime as r, getMSTeamsRuntime as t };
