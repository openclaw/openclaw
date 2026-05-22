import { a as shouldLogVerbose } from "./globals-ZEce9oym.js";
import { a as chunkText } from "./chunk-B_CySsI6.js";
import "./runtime-env-B1r2kK7q.js";
import "./reply-chunking-5Kq5TVuU.js";
import { t as resolveWhatsAppOutboundTarget } from "./resolve-outbound-target-BKw6raPR.js";
import { n as normalizeWhatsAppPayloadText } from "./outbound-media-contract-86t_6B5V.js";
import { t as createWhatsAppOutboundBase } from "./outbound-base-8KfG0a4a.js";
//#region extensions/whatsapp/src/outbound-adapter.ts
let whatsAppSendModulePromise;
function loadWhatsAppSendModule() {
	whatsAppSendModulePromise ??= import("./send-CMxck13m.js");
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
