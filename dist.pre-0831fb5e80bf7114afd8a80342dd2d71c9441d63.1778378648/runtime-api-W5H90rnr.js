import "./file-lock-COVDy3ri.js";
import { t as createPluginRuntimeStore } from "./runtime-store-BY975gH9.js";
import "./channel-policy-C4Te_3Ry.js";
import "./inbound-reply-dispatch-DqXmOgES.js";
import "./outbound-media-BrEHWnh4.js";
import "./ssrf-runtime-CN3oFExA.js";
import "./media-runtime-BzgZghzj.js";
import "./channel-status-B1B6b1FE.js";
import "./channel-lifecycle-BQl65-8k.js";
import "./channel-message-CF65m1xH.js";
import "./channel-pairing-Ccj9LOYk.js";
import "./channel-targets-QrxEvpVz.js";
import "./webhook-ingress-Wp3c-Hzz.js";
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime, tryGetRuntime: getOptionalMSTeamsRuntime } = createPluginRuntimeStore({
	pluginId: "msteams",
	errorMessage: "MSTeams runtime not initialized"
});
//#endregion
export { getOptionalMSTeamsRuntime as n, setMSTeamsRuntime as r, getMSTeamsRuntime as t };
