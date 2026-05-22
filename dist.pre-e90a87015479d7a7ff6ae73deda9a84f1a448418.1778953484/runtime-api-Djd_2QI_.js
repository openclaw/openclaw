import "./file-lock-B9OEQPVi.js";
import { t as createPluginRuntimeStore } from "./runtime-store-LLLxGXsu.js";
import "./channel-policy-B7MF_g_y.js";
import "./inbound-reply-dispatch-B41g3V5u.js";
import "./outbound-media-B7ZnVQHz.js";
import "./ssrf-runtime-CaWyYFbv.js";
import "./media-runtime-DeuscnM0.js";
import "./text-chunking-WnXdOF_7.js";
import "./channel-status-DWmZgOx2.js";
import "./channel-lifecycle-BdkDlmFA.js";
import "./channel-message-B1-LA4aR.js";
import "./channel-pairing-BR8BiOoy.js";
import "./channel-targets-BYNoxkkr.js";
import "./webhook-ingress-ChYTsoY4.js";
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime, tryGetRuntime: getOptionalMSTeamsRuntime } = createPluginRuntimeStore({
	pluginId: "msteams",
	errorMessage: "MSTeams runtime not initialized"
});
//#endregion
export { getOptionalMSTeamsRuntime as n, setMSTeamsRuntime as r, getMSTeamsRuntime as t };
