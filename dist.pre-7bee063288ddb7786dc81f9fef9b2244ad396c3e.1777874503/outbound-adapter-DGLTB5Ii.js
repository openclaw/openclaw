import { a as shouldLogVerbose } from "./globals-C7I_COwU.js";
import { a as chunkText } from "./chunk-D2H_19Xb.js";
import "./runtime-env-BBcuHj0d.js";
import "./reply-chunking-CRxdpUGk.js";
import { t as resolveWhatsAppOutboundTarget } from "./resolve-outbound-target-b5cWrJGj.js";
import { n as normalizeWhatsAppPayloadText } from "./outbound-media-contract-C6myiRkB.js";
import { t as createWhatsAppOutboundBase } from "./outbound-base-D0CVwPT0.js";
//#region extensions/whatsapp/src/outbound-adapter.ts
let whatsAppSendModulePromise;
function loadWhatsAppSendModule() {
	whatsAppSendModulePromise ??= import("./send-DIUbXu22.js");
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
