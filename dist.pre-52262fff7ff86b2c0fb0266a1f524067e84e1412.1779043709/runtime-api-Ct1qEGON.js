import "./file-lock-BhZ1fIVv.js";
import { t as createPluginRuntimeStore } from "./runtime-store-2ORR7yfg.js";
import "./channel-policy-BdE7sbCm.js";
import "./inbound-reply-dispatch-D-CSv0M5.js";
import "./outbound-media-dSy4I5H5.js";
import "./ssrf-runtime-BDi9tXcb.js";
import "./media-runtime-BqjAMS-d.js";
import "./text-chunking-DZnxKaUJ.js";
import "./channel-status-CoOBYmoa.js";
import "./channel-lifecycle-qyrUoA-W.js";
import "./channel-message-CHkrbl6L.js";
import "./channel-pairing-9_fRH2pa.js";
import "./channel-targets-o03sdlLh.js";
import "./webhook-ingress-Da7h5Mdh.js";
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime, tryGetRuntime: getOptionalMSTeamsRuntime } = createPluginRuntimeStore({
	pluginId: "msteams",
	errorMessage: "MSTeams runtime not initialized"
});
//#endregion
export { getOptionalMSTeamsRuntime as n, setMSTeamsRuntime as r, getMSTeamsRuntime as t };
