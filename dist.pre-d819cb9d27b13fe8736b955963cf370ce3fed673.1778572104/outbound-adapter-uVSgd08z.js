import { a as shouldLogVerbose } from "./globals-2rjcRy6M.js";
import { a as chunkText } from "./chunk-Cwj1J7Kz.js";
import "./runtime-env-zJY-klAY.js";
import "./reply-chunking-DxLzKfea.js";
import { t as resolveWhatsAppOutboundTarget } from "./resolve-outbound-target-Be8_P5DY.js";
import { n as normalizeWhatsAppPayloadText } from "./outbound-media-contract-050LP-cU.js";
import { t as createWhatsAppOutboundBase } from "./outbound-base-qyI7QlRP.js";
//#region extensions/whatsapp/src/outbound-adapter.ts
let whatsAppSendModulePromise;
function loadWhatsAppSendModule() {
	whatsAppSendModulePromise ??= import("./send-C9btTTF4.js");
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
