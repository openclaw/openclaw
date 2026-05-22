import "./file-lock-BhZ1fIVv.js";
import { t as createPluginRuntimeStore } from "./runtime-store-Ck0e4Li2.js";
import "./channel-policy-C9e05gYV.js";
import "./inbound-reply-dispatch-CNy_GAMy.js";
import "./outbound-media-BwT1-glW.js";
import "./ssrf-runtime-Cu4zbqxY.js";
import "./media-runtime-CTGr8VtE.js";
import "./text-chunking-CfgOiEjf.js";
import "./channel-status-DmDLldrU.js";
import "./channel-lifecycle-WVFAsKkA.js";
import "./channel-message-DeX9rRst.js";
import "./channel-pairing-DQlMxx4e.js";
import "./channel-targets-vouyZaLg.js";
import "./webhook-ingress-CvxMRP6i.js";
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime, tryGetRuntime: getOptionalMSTeamsRuntime } = createPluginRuntimeStore({
	pluginId: "msteams",
	errorMessage: "MSTeams runtime not initialized"
});
//#endregion
export { getOptionalMSTeamsRuntime as n, setMSTeamsRuntime as r, getMSTeamsRuntime as t };
