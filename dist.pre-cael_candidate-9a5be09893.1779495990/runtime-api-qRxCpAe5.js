import "./file-lock-D5OTq3qW.js";
import { t as createPluginRuntimeStore } from "./runtime-store-Cezm5nT2.js";
import "./channel-policy-wv7Jiuub.js";
import "./inbound-reply-dispatch-CBRFuqY7.js";
import "./outbound-media-vAhpTcTX.js";
import "./ssrf-runtime-Db7Y0wil.js";
import "./media-runtime-DTV5lL4v.js";
import "./text-chunking-CVvpFHIe.js";
import "./channel-status-CgLm1zs_.js";
import "./channel-lifecycle-zAmglhsU.js";
import "./channel-message-DkD03ToM.js";
import "./channel-pairing-C53hVVH8.js";
import "./channel-targets-BQYAAgR7.js";
import "./webhook-ingress-gd9GGtpF.js";
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime, tryGetRuntime: getOptionalMSTeamsRuntime } = createPluginRuntimeStore({
	pluginId: "msteams",
	errorMessage: "MSTeams runtime not initialized"
});
//#endregion
export { getOptionalMSTeamsRuntime as n, setMSTeamsRuntime as r, getMSTeamsRuntime as t };
