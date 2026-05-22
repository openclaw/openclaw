import { a as shouldLogVerbose } from "./globals-CQst_TEw.js";
import { a as chunkText } from "./chunk-Cwj1J7Kz.js";
import "./runtime-env-DctltjLk.js";
import "./reply-chunking-DxLzKfea.js";
import { t as resolveWhatsAppOutboundTarget } from "./resolve-outbound-target-DXwkwa5M.js";
import { n as normalizeWhatsAppPayloadText } from "./outbound-media-contract-BoTTZ5co.js";
import { t as createWhatsAppOutboundBase } from "./outbound-base-CsQ68_VR.js";
//#region extensions/whatsapp/src/outbound-adapter.ts
let whatsAppSendModulePromise;
function loadWhatsAppSendModule() {
	whatsAppSendModulePromise ??= import("./send-BtG4HC22.js");
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
