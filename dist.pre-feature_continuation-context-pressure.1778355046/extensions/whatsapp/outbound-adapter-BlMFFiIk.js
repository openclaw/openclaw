import { a as shouldLogVerbose } from "../../globals-BHVmraBM.js";
import { a as chunkText } from "../../chunk-Bkxjj_pw.js";
import "../../runtime-env-DyZrKYOx.js";
import "../../reply-chunking-D-vq0kAq.js";
import { t as resolveWhatsAppOutboundTarget } from "./resolve-outbound-target-D_tHM56Y.js";
import { n as normalizeWhatsAppPayloadText } from "./outbound-media-contract-m2QJKN8I.js";
import { t as createWhatsAppOutboundBase } from "./outbound-base-DPIwvj0n.js";
//#region extensions/whatsapp/src/outbound-adapter.ts
let whatsAppSendModulePromise;
function loadWhatsAppSendModule() {
	whatsAppSendModulePromise ??= import("./send-xppnsSln.js");
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
