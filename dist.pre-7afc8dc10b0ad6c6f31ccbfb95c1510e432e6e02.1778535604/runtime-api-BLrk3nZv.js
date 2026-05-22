import "./file-lock-DQUKRk1a.js";
import { t as createPluginRuntimeStore } from "./runtime-store-Gsztj7De.js";
import "./channel-policy-BAbLgp6f.js";
import "./inbound-reply-dispatch-qWMXEnPi.js";
import "./outbound-media-3GKBi6ht.js";
import "./ssrf-runtime-CkUGpkoc.js";
import "./media-runtime-VIdlgue-.js";
import "./channel-status-BOptdune.js";
import "./channel-lifecycle-DKl5ZvEM.js";
import "./channel-message-DLRlnHTh.js";
import "./channel-pairing-DE1ZGqNp.js";
import "./channel-targets-3qZBU0QF.js";
import "./webhook-ingress-ATbUhfx-.js";
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime, tryGetRuntime: getOptionalMSTeamsRuntime } = createPluginRuntimeStore({
	pluginId: "msteams",
	errorMessage: "MSTeams runtime not initialized"
});
//#endregion
export { getOptionalMSTeamsRuntime as n, setMSTeamsRuntime as r, getMSTeamsRuntime as t };
