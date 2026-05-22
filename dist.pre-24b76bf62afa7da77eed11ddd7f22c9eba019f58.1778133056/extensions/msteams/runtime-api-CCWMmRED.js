import "../../file-lock-CQT0mhTn.js";
import "../../channel-reply-pipeline-TlW8N3_3.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-Wij_b93b.js";
import "../../channel-policy-CJIN_g7f.js";
import "../../channel-targets-DHuX-MKO.js";
import "../../channel-pairing-CWWMPhAh.js";
import "../../webhook-ingress-Bk-4qyTw.js";
import "../../inbound-reply-dispatch-BCOdLV9x.js";
import "../../outbound-media-Dl3SXxKB.js";
import "../../ssrf-runtime-BoUUJCOc.js";
import "../../media-runtime-CfGiZyk2.js";
import "../../channel-status-Bs_3DYkc.js";
import "../../channel-lifecycle-Cabry67M.js";
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime, tryGetRuntime: getOptionalMSTeamsRuntime } = createPluginRuntimeStore({
	pluginId: "msteams",
	errorMessage: "MSTeams runtime not initialized"
});
//#endregion
export { getOptionalMSTeamsRuntime as n, setMSTeamsRuntime as r, getMSTeamsRuntime as t };
