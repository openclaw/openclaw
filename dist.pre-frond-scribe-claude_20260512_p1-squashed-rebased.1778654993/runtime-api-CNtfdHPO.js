import { t as createPluginRuntimeStore } from "./runtime-store-OWAYvd1I.js";
import "./outbound-media-DARTnhOj.js";
import "./ssrf-runtime-DeVcz7VH.js";
import "./media-runtime-DZ1nM-JH.js";
import "./text-chunking-Dd4mHdk2.js";
import "./channel-status-v0vCi1Fh.js";
import "./bundled-channel-config-schema-DzvLjeM7.js";
import "./channel-config-primitives-5hIAXGrT.js";
import "./channel-actions-BE_JGbx7.js";
import "./channel-feedback-BCMq5nO5.js";
import "./channel-inbound-D36kErdP.js";
import "./channel-lifecycle-Ddl1fuhg.js";
import "./channel-message-C3RkR_ru.js";
import "./channel-pairing-CD9Xu5WD.js";
import "./webhook-ingress-DhqeChgA.js";
import "./webhook-request-guards-B4AXHaAK.js";
import "./webhook-targets-DEvAVmO0.js";
//#region extensions/googlechat/src/runtime.ts
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore({
	pluginId: "googlechat",
	errorMessage: "Google Chat runtime not initialized"
});
//#endregion
export { setGoogleChatRuntime as n, getGoogleChatRuntime as t };
