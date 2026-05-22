import { t as createPluginRuntimeStore } from "./runtime-store-BY975gH9.js";
import "./channel-policy-C4Te_3Ry.js";
import "./outbound-media-BrEHWnh4.js";
import "./ssrf-runtime-CN3oFExA.js";
import "./media-runtime-BzgZghzj.js";
import "./channel-status-B1B6b1FE.js";
import "./bundled-channel-config-schema-DBcRSwK6.js";
import "./channel-config-primitives-x5_3Splf.js";
import "./channel-actions-DZWZrRK6.js";
import "./channel-feedback-Dp0D8hct.js";
import "./channel-inbound-BWNrQAR8.js";
import "./channel-lifecycle-BQl65-8k.js";
import "./channel-message-CF65m1xH.js";
import "./channel-pairing-Ccj9LOYk.js";
import "./webhook-request-guards-BYYa19g0.js";
import "./webhook-targets-B_Je-KFl.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
