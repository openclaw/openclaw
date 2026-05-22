import "./file-lock-BpVvAoco.js";
import { t as createPluginRuntimeStore } from "./runtime-store-OWAYvd1I.js";
import "./channel-policy-B29bnsBT.js";
import "./inbound-reply-dispatch-FAVsQVqZ.js";
import "./outbound-media-DARTnhOj.js";
import "./ssrf-runtime-DeVcz7VH.js";
import "./media-runtime-DZ1nM-JH.js";
import "./text-chunking-Dd4mHdk2.js";
import "./channel-status-v0vCi1Fh.js";
import "./channel-lifecycle-Ddl1fuhg.js";
import "./channel-message-C3RkR_ru.js";
import "./channel-pairing-CD9Xu5WD.js";
import "./channel-targets-CrtCZNIm.js";
import "./webhook-ingress-DhqeChgA.js";
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime, tryGetRuntime: getOptionalMSTeamsRuntime } = createPluginRuntimeStore({
	pluginId: "msteams",
	errorMessage: "MSTeams runtime not initialized"
});
//#endregion
export { getOptionalMSTeamsRuntime as n, setMSTeamsRuntime as r, getMSTeamsRuntime as t };
