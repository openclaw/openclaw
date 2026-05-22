import { a as shouldLogVerbose } from "./globals-CsZphy1u.js";
import { a as chunkText } from "./chunk-CVo5aUOt.js";
import "./runtime-env-UeKVf4aK.js";
import "./reply-chunking-B3BoGgOm.js";
import { t as resolveWhatsAppOutboundTarget } from "./resolve-outbound-target-DF2inbWW.js";
import { n as normalizeWhatsAppPayloadText } from "./outbound-media-contract-CIeTzMC3.js";
import { t as createWhatsAppOutboundBase } from "./outbound-base-l_qF3xOM.js";
//#region extensions/whatsapp/src/outbound-adapter.ts
let whatsAppSendModulePromise;
function loadWhatsAppSendModule() {
	whatsAppSendModulePromise ??= import("./send-DBj1aN2K.js");
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
