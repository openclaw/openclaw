import { a as shouldLogVerbose } from "./globals-ZEce9oym.js";
import { a as chunkText } from "./chunk-WLwao7GS.js";
import "./runtime-env-SuJzy_mk.js";
import "./reply-chunking-DGsh_D0u.js";
import { t as resolveWhatsAppOutboundTarget } from "./resolve-outbound-target-kI884t8s.js";
import { n as normalizeWhatsAppPayloadText } from "./outbound-media-contract-CUnDljHL.js";
import { t as createWhatsAppOutboundBase } from "./outbound-base-C1_j2b-x.js";
//#region extensions/whatsapp/src/outbound-adapter.ts
let whatsAppSendModulePromise;
function loadWhatsAppSendModule() {
	whatsAppSendModulePromise ??= import("./send-CxC4Vrcl.js");
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
