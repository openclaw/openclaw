import "./file-lock-DDZT8E76.js";
import { t as createPluginRuntimeStore } from "./runtime-store-Cigg_Veg.js";
import "./channel-policy-DorgJeIC.js";
import "./inbound-reply-dispatch-BoJXUblV.js";
import "./outbound-media-BTsScThx.js";
import "./ssrf-runtime-B7YsbRmp.js";
import "./media-runtime-DWh6m_8p.js";
import "./text-chunking-3_9rfiI8.js";
import "./channel-status-DQzE7laT.js";
import "./channel-lifecycle-BrKB268B.js";
import "./channel-message-CmG6T1ry.js";
import "./channel-pairing--8umY0wm.js";
import "./channel-targets-DqRLwtU8.js";
import "./webhook-ingress-T_7zkgKq.js";
//#region extensions/msteams/src/runtime.ts
const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime, tryGetRuntime: getOptionalMSTeamsRuntime } = createPluginRuntimeStore({
	pluginId: "msteams",
	errorMessage: "MSTeams runtime not initialized"
});
//#endregion
export { getOptionalMSTeamsRuntime as n, setMSTeamsRuntime as r, getMSTeamsRuntime as t };
