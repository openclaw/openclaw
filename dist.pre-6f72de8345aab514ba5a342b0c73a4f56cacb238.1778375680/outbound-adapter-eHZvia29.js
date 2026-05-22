import { a as shouldLogVerbose } from "./globals-f3TwV797.js";
import { a as chunkText } from "./chunk-DNRzZy_M.js";
import "./runtime-env-DrpEm7Eb.js";
import "./reply-chunking-CouQwlzZ.js";
import { t as resolveWhatsAppOutboundTarget } from "./resolve-outbound-target-DQ6enHa4.js";
import { n as normalizeWhatsAppPayloadText } from "./outbound-media-contract-h2VGd8p7.js";
import { t as createWhatsAppOutboundBase } from "./outbound-base-CRbnQ0Hj.js";
//#region extensions/whatsapp/src/outbound-adapter.ts
let whatsAppSendModulePromise;
function loadWhatsAppSendModule() {
	whatsAppSendModulePromise ??= import("./send-Cg0L5Xip.js");
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
