import { n as missingTargetError } from "../../target-errors-CtwFM1M8.js";
import "../../channel-feedback-Dv8VDS0X.js";
import { c as normalizeWhatsAppTarget, n as isWhatsAppNewsletterJid, t as isWhatsAppGroupJid } from "./normalize-target-Cl_bQnZk.js";
//#region extensions/whatsapp/src/resolve-outbound-target.ts
function whatsappAllowFromPolicyError(target) {
	return /* @__PURE__ */ new Error(`Target "${target}" is not listed in the configured WhatsApp allowFrom policy.`);
}
function resolveWhatsAppOutboundTarget(params) {
	const trimmed = params.to?.trim() ?? "";
	if (!trimmed) return {
		ok: false,
		error: missingTargetError("WhatsApp", "<E.164|group JID|newsletter JID>")
	};
	const normalizedTo = normalizeWhatsAppTarget(trimmed);
	if (!normalizedTo) return {
		ok: false,
		error: missingTargetError("WhatsApp", "<E.164|group JID|newsletter JID>")
	};
	if (isWhatsAppGroupJid(normalizedTo) || isWhatsAppNewsletterJid(normalizedTo)) return {
		ok: true,
		to: normalizedTo
	};
	const allowListRaw = (params.allowFrom ?? []).map((entry) => String(entry).trim()).filter(Boolean);
	const hasWildcard = allowListRaw.includes("*");
	const allowList = allowListRaw.filter((entry) => entry !== "*").map((entry) => normalizeWhatsAppTarget(entry)).filter((entry) => Boolean(entry));
	if (hasWildcard || allowList.length === 0) return {
		ok: true,
		to: normalizedTo
	};
	if (allowList.includes(normalizedTo)) return {
		ok: true,
		to: normalizedTo
	};
	return {
		ok: false,
		error: whatsappAllowFromPolicyError(normalizedTo)
	};
}
//#endregion
export { resolveWhatsAppOutboundTarget as t };
