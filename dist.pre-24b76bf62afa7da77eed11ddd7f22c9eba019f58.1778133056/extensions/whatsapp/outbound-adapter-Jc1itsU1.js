import { a as shouldLogVerbose } from "../../globals-Byqe4NlR.js";
import { a as chunkText } from "../../chunk-C2kl4p0h.js";
import "../../runtime-env-BdFx1dy-.js";
import "../../reply-chunking-DEzcus5y.js";
import { t as resolveWhatsAppOutboundTarget } from "./resolve-outbound-target-AXB-Id3k.js";
import { n as normalizeWhatsAppPayloadText } from "./outbound-media-contract-CaTLBcrD.js";
import { t as createWhatsAppOutboundBase } from "./outbound-base-7Ngte9IF.js";
//#region extensions/whatsapp/src/outbound-adapter.ts
let whatsAppSendModulePromise;
function loadWhatsAppSendModule() {
	whatsAppSendModulePromise ??= import("./send-_gGwoQmN.js");
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
