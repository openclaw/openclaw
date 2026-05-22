import { t as createPluginRuntimeStore } from "./runtime-store-Cg9cOb9V.js";
import "./channel-policy-BLtDHk3I.js";
import "./outbound-media-D5gVno6y.js";
import "./ssrf-runtime-BdcRu7L4.js";
import "./media-runtime-DMdnxXjU.js";
import "./channel-status-DqKjqAvf.js";
import "./bundled-channel-config-schema-BYSl9ptf.js";
import "./channel-config-primitives-BoZTAphr.js";
import "./channel-actions-Cmk6tqyd.js";
import "./channel-feedback-DQNZZXP1.js";
import "./channel-inbound-HtT6SSTJ.js";
import "./channel-lifecycle-CgCVCHY8.js";
import "./channel-message-Bzk-dIXe.js";
import "./channel-pairing-DX2KqVMh.js";
import "./webhook-request-guards-DdIT8L7Q.js";
import "./webhook-targets-Bloj0ok3.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
