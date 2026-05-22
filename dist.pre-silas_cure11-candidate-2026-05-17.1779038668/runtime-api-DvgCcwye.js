import "./file-lock-CCOJxG89.js";
import { t as createPluginRuntimeStore } from "./runtime-store-DUe79kGC.js";
import "./channel-policy-YBir_Mqh.js";
import "./inbound-reply-dispatch-D49bZ0X6.js";
import "./outbound-media-C8Wz7t5K.js";
import "./ssrf-runtime-Cvk-tl6n.js";
import "./media-runtime-Cu1-Pffz.js";
import "./text-chunking-BdRhujLD.js";
import "./channel-status-Bf1Fg2Mi.js";
import "./channel-lifecycle-D2W50h3z.js";
import "./channel-message-D59fEK6f.js";
import "./channel-pairing-Dihocv8_.js";
import "./channel-targets-WeXIAZid.js";
import "./webhook-ingress-BtuAIoc2.js";
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime, tryGetRuntime: getOptionalMSTeamsRuntime } = createPluginRuntimeStore({
	pluginId: "msteams",
	errorMessage: "MSTeams runtime not initialized"
});
//#endregion
export { getOptionalMSTeamsRuntime as n, setMSTeamsRuntime as r, getMSTeamsRuntime as t };
