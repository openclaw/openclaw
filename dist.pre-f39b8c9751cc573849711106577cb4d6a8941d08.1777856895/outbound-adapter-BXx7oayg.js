import { a as shouldLogVerbose } from "./globals-Dn_zSD2h.js";
import { a as chunkText } from "./chunk-DVhbCEt5.js";
import "./runtime-env-PjQ_OX8O.js";
import "./reply-chunking-DaWggL0q.js";
import { t as resolveWhatsAppOutboundTarget } from "./resolve-outbound-target-ByTWwSUt.js";
import { n as normalizeWhatsAppPayloadText } from "./outbound-media-contract-DaBf67rY.js";
import { t as createWhatsAppOutboundBase } from "./outbound-base-BeAeesZD.js";
//#region extensions/whatsapp/src/outbound-adapter.ts
let whatsAppSendModulePromise;
function loadWhatsAppSendModule() {
	whatsAppSendModulePromise ??= import("./send-HUPDgLo-.js");
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
