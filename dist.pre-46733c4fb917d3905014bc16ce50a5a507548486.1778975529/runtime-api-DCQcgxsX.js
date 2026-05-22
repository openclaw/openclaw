import "./file-lock-CCOJxG89.js";
import { t as createPluginRuntimeStore } from "./runtime-store-CSfjApnh.js";
import "./channel-policy-DZVnEADB.js";
import "./inbound-reply-dispatch-2qLMEfR9.js";
import "./outbound-media-ButoEKx2.js";
import "./ssrf-runtime-DPexcW9I.js";
import "./media-runtime-B6CavSZQ.js";
import "./text-chunking-BDDPJPB6.js";
import "./channel-status-7KUVffLE.js";
import "./channel-lifecycle-BwwIv78-.js";
import "./channel-message-D8XpAab3.js";
import "./channel-pairing-DDbNNRH5.js";
import "./channel-targets-DCBJQyWz.js";
import "./webhook-ingress-CNfu7BL2.js";
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime, tryGetRuntime: getOptionalMSTeamsRuntime } = createPluginRuntimeStore({
	pluginId: "msteams",
	errorMessage: "MSTeams runtime not initialized"
});
//#endregion
export { getOptionalMSTeamsRuntime as n, setMSTeamsRuntime as r, getMSTeamsRuntime as t };
