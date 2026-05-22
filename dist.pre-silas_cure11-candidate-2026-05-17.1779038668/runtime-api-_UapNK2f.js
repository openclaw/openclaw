import { t as createPluginRuntimeStore } from "./runtime-store-DUe79kGC.js";
import "./outbound-media-C8Wz7t5K.js";
import "./ssrf-runtime-Cvk-tl6n.js";
import "./media-runtime-Cu1-Pffz.js";
import "./text-chunking-BdRhujLD.js";
import "./channel-status-Bf1Fg2Mi.js";
import "./bundled-channel-config-schema-BZx-IoDt.js";
import "./channel-config-primitives-DZOU9Io7.js";
import "./channel-actions-DKEW9VMF.js";
import "./channel-feedback-wY02LtPn.js";
import "./channel-inbound-Cs1W7zVE.js";
import "./channel-lifecycle-D2W50h3z.js";
import "./channel-message-D59fEK6f.js";
import "./channel-pairing-Dihocv8_.js";
import "./webhook-ingress-BtuAIoc2.js";
import "./webhook-request-guards-Bf58hdP0.js";
import "./webhook-targets-D55G90AD.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
