import "../../channel-reply-pipeline-TlW8N3_3.js";
import { t as createPluginRuntimeStore } from "../../runtime-store-Wij_b93b.js";
import "../../channel-policy-CJIN_g7f.js";
import "../../channel-pairing-CWWMPhAh.js";
import "../../webhook-request-guards-DOcGOAX7.js";
import "../../webhook-targets-ZH8ppUbz.js";
import "../../outbound-media-Dl3SXxKB.js";
import "../../ssrf-runtime-BoUUJCOc.js";
import "../../media-runtime-CfGiZyk2.js";
import "../../channel-status-Bs_3DYkc.js";
import "../../bundled-channel-config-schema-CXwIO9Ey.js";
import "../../channel-config-primitives-DtE1-MW3.js";
import "../../channel-actions-Dvpzx5Sm.js";
import "../../channel-feedback-Dv8VDS0X.js";
import "../../channel-inbound-yyERWA6V.js";
import "../../channel-lifecycle-Cabry67M.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
