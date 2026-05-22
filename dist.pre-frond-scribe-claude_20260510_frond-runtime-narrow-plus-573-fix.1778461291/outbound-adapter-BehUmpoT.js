import { a as shouldLogVerbose } from "./globals-ZEce9oym.js";
import { a as chunkText } from "./chunk-D4-hvVxC.js";
import "./runtime-env-BAVnmgBK.js";
import "./reply-chunking-BXO7mtBU.js";
import { t as resolveWhatsAppOutboundTarget } from "./resolve-outbound-target-TWQRYFvT.js";
import { n as normalizeWhatsAppPayloadText } from "./outbound-media-contract-CAohX91C.js";
import { t as createWhatsAppOutboundBase } from "./outbound-base-DInNAQeI.js";
//#region extensions/whatsapp/src/outbound-adapter.ts
let whatsAppSendModulePromise;
function loadWhatsAppSendModule() {
	whatsAppSendModulePromise ??= import("./send-O6-eaKFk.js");
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
