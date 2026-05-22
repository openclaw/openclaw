import "../../file-lock-D40bDp48.js";
import "../../channel-reply-pipeline-DR9vcaJj.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-D2rbMekf.js";
import "../../channel-policy-5FBdjNP7.js";
import "../../channel-targets-B-Xg69OS.js";
import "../../channel-pairing-BI_ZJIJ_.js";
import "../../webhook-ingress-mIF0Mq5f.js";
import "../../inbound-reply-dispatch-B0ZjYKzs.js";
import "../../outbound-media-ggFx4c0j.js";
import "../../ssrf-runtime-BGM8nkUl.js";
import "../../media-runtime-B3sgGdPE.js";
import "../../channel-status-CGjVWC2r.js";
import "../../channel-lifecycle-D27EMvrw.js";
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime, tryGetRuntime: getOptionalMSTeamsRuntime } = createPluginRuntimeStore({
	pluginId: "msteams",
	errorMessage: "MSTeams runtime not initialized"
});
//#endregion
export { getOptionalMSTeamsRuntime as n, setMSTeamsRuntime as r, getMSTeamsRuntime as t };
