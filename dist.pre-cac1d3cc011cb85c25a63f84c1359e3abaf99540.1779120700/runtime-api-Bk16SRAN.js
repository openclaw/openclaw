import { t as createPluginRuntimeStore } from "./runtime-store-Ck0e4Li2.js";
import "./outbound-media-D_zXhfL3.js";
import "./ssrf-runtime-DiZYIPIC.js";
import "./media-runtime-eri84b_Q.js";
import "./text-chunking-CfgOiEjf.js";
import "./channel-status-DYYgC8Iv.js";
import "./bundled-channel-config-schema-DKky0-Dd.js";
import "./channel-config-primitives-dWjW2z3p.js";
import "./channel-actions-1jr9URgQ.js";
import "./channel-feedback-7pbU-aDw.js";
import "./channel-inbound-B7u0JObw.js";
import "./channel-lifecycle-BR9KkA_z.js";
import "./channel-message-CBQ4P6FK.js";
import "./channel-pairing-Dn50-hnB.js";
import "./webhook-ingress-CdKNG8ep.js";
import "./webhook-request-guards-CzzwUh0h.js";
import "./webhook-targets-DbBbaY6U.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
