import { a as shouldLogVerbose } from "../../globals-BHVmraBM.js";
import { a as chunkText } from "../../chunk-8IibRYUU.js";
import "../../runtime-env-DVyvKnep.js";
import "../../reply-chunking-Af3JJwcP.js";
import { t as resolveWhatsAppOutboundTarget } from "./resolve-outbound-target-Du_ysMSx.js";
import { n as normalizeWhatsAppPayloadText } from "./outbound-media-contract-Bm172mhf.js";
import { t as createWhatsAppOutboundBase } from "./outbound-base-BAnzWwjX.js";
//#region extensions/whatsapp/src/outbound-adapter.ts
let whatsAppSendModulePromise;
function loadWhatsAppSendModule() {
	whatsAppSendModulePromise ??= import("./send-Dd5f5jqN.js");
	return whatsAppSendModulePromise;
}
function normalizeOutboundText(text) {
	return normalizeWhatsAppPayloadText(text);
}
const whatsappOutbound = createWhatsAppOutboundBase({
	chunker: chunkText,
	sendMessageWhatsApp: async (to, text, options) => await (await loadWhatsAppSendModule()).sendMessageWhatsApp(to, normalizeOutboundText(text), { ...options }),
	sendPollWhatsApp: async (to, poll, options) => await (await loadWhatsAppSendModule()).sendPollWhatsApp(to, poll, options),
	shouldLogVerbose: () => shouldLogVerbose(),
	resolveTarget: ({ to, allowFrom, mode }) => resolveWhatsAppOutboundTarget({
		to,
		allowFrom,
		mode
	}),
	normalizeText: normalizeOutboundText,
	skipEmptyText: true
});
//#endregion
export { whatsappOutbound as t };
