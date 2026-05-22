import { t as createPluginRuntimeStore } from "./runtime-store-Ck0e4Li2.js";
import "./outbound-media-BwT1-glW.js";
import "./ssrf-runtime-Cu4zbqxY.js";
import "./media-runtime-CTGr8VtE.js";
import "./text-chunking-CfgOiEjf.js";
import "./channel-status-DmDLldrU.js";
import "./bundled-channel-config-schema-CR_47WNy.js";
import "./channel-config-primitives-B48gCKrK.js";
import "./channel-actions-D9wV-pMg.js";
import "./channel-feedback-BCWUG13F.js";
import "./channel-inbound-Cx0B5P3W.js";
import "./channel-lifecycle-WVFAsKkA.js";
import "./channel-message-DeX9rRst.js";
import "./channel-pairing-DQlMxx4e.js";
import "./webhook-ingress-CvxMRP6i.js";
import "./webhook-request-guards-B_hiCqkT.js";
import "./webhook-targets-oJjmEjNQ.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
