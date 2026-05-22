import "./file-lock-D5OTq3qW.js";
import { t as createPluginRuntimeStore } from "./runtime-store-Cezm5nT2.js";
import "./channel-policy-DPWQPgLK.js";
import "./inbound-reply-dispatch-CifswBP0.js";
import "./outbound-media-GCXqMq5T.js";
import "./ssrf-runtime-BxfNsut3.js";
import "./media-runtime-C5IoNmJM.js";
import "./text-chunking-B1eCf5mf.js";
import "./channel-status-pmRGSI7K.js";
import "./channel-lifecycle-Bw0QrZJX.js";
import "./channel-message-CO23hUpq.js";
import "./channel-pairing-BQ9lyBd_.js";
import "./channel-targets-CjAegtFg.js";
import "./webhook-ingress-bP21RBa9.js";
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime, tryGetRuntime: getOptionalMSTeamsRuntime } = createPluginRuntimeStore({
	pluginId: "msteams",
	errorMessage: "MSTeams runtime not initialized"
});
//#endregion
export { getOptionalMSTeamsRuntime as n, setMSTeamsRuntime as r, getMSTeamsRuntime as t };
