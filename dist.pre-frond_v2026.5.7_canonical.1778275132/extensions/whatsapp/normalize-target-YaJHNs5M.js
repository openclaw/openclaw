import { a as normalizeLowercaseStringOrEmpty } from "../../string-coerce-Bje8XVt9.js";
import { l as normalizeE164 } from "../../utils-D5swhEXt.js";
import "../../text-runtime-DCigKjjg.js";
import "../../account-resolution-Brm4mbTl.js";
//#region extensions/whatsapp/src/normalize-target.ts
const WHATSAPP_USER_JID_RE = /^(\d+)(?::\d+)?@s\.whatsapp\.net$/i;
const WHATSAPP_LEGACY_USER_JID_RE = /^(\d+)@c\.us$/i;
const WHATSAPP_LID_RE = /^(\d+)@lid$/i;
const NON_WHATSAPP_PROVIDER_PREFIX_RE = /^[a-z][a-z0-9-]*:/i;
const WHATSAPP_NEWSLETTER_JID_RE = /^([0-9]+)@newsletter$/i;
function stripWhatsAppTargetPrefixes(value) {
	let candidate = value.trim();
	for (;;) {
		const before = candidate;
		candidate = candidate.replace(/^whatsapp:/i, "").trim();
		if (candidate === before) return candidate;
	}
}
function isWhatsAppGroupJid(value) {
	const candidate = stripWhatsAppTargetPrefixes(value);
	if (!normalizeLowercaseStringOrEmpty(candidate).endsWith("@g.us")) return false;
	const localPart = candidate.slice(0, candidate.length - 5);
	if (!localPart || localPart.includes("@")) return false;
	return /^[0-9]+(-[0-9]+)*$/.test(localPart);
}
function isWhatsAppNewsletterJid(value) {
	const candidate = stripWhatsAppTargetPrefixes(value);
	return WHATSAPP_NEWSLETTER_JID_RE.test(candidate);
}
function isWhatsAppUserTarget(value) {
	const candidate = stripWhatsAppTargetPrefixes(value);
	return WHATSAPP_USER_JID_RE.test(candidate) || WHATSAPP_LEGACY_USER_JID_RE.test(candidate) || WHATSAPP_LID_RE.test(candidate);
}
function extractUserJidPhone(jid) {
	const userMatch = jid.match(WHATSAPP_USER_JID_RE);
	if (userMatch) return userMatch[1];
	const legacyUserMatch = jid.match(WHATSAPP_LEGACY_USER_JID_RE);
	if (legacyUserMatch) return legacyUserMatch[1];
	const lidMatch = jid.match(WHATSAPP_LID_RE);
	if (lidMatch) return lidMatch[1];
	return null;
}
function normalizeWhatsAppTarget(value) {
	const candidate = stripWhatsAppTargetPrefixes(value);
	if (!candidate) return null;
	if (isWhatsAppGroupJid(candidate)) return `${candidate.slice(0, candidate.length - 5)}@g.us`;
	if (isWhatsAppNewsletterJid(candidate)) {
		const match = candidate.match(WHATSAPP_NEWSLETTER_JID_RE);
		return match ? `${match[1]}@newsletter` : null;
	}
	if (isWhatsAppUserTarget(candidate)) {
		const phone = extractUserJidPhone(candidate);
		if (!phone) return null;
		const normalized = normalizeE164(phone);
		return normalized.length > 1 ? normalized : null;
	}
	if (candidate.includes("@")) return null;
	if (NON_WHATSAPP_PROVIDER_PREFIX_RE.test(candidate)) return null;
	const normalized = normalizeE164(candidate);
	return normalized.length > 1 ? normalized : null;
}
function normalizeWhatsAppMessagingTarget(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return;
	return normalizeWhatsAppTarget(trimmed) ?? void 0;
}
function normalizeWhatsAppAllowFromEntries(allowFrom) {
	const seen = /* @__PURE__ */ new Set();
	return allowFrom.map((entry) => String(entry).trim()).filter((entry) => Boolean(entry)).map(normalizeWhatsAppAllowFromEntry).filter((entry) => Boolean(entry)).filter((entry) => {
		if (seen.has(entry)) return false;
		seen.add(entry);
		return true;
	});
}
function normalizeWhatsAppAllowFromEntry(entry) {
	if (entry === "*") return entry;
	const normalized = normalizeWhatsAppTarget(entry);
	if (!normalized) return null;
	return normalized.startsWith("+") ? normalized.slice(1) : normalized;
}
function looksLikeWhatsAppTargetId(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return false;
	return /^whatsapp:/i.test(trimmed) || isWhatsAppGroupJid(trimmed) || isWhatsAppNewsletterJid(trimmed) || isWhatsAppUserTarget(trimmed) || normalizeWhatsAppTarget(trimmed) !== null;
}
//#endregion
export { normalizeWhatsAppAllowFromEntries as a, normalizeWhatsAppTarget as c, looksLikeWhatsAppTargetId as i, isWhatsAppNewsletterJid as n, normalizeWhatsAppAllowFromEntry as o, isWhatsAppUserTarget as r, normalizeWhatsAppMessagingTarget as s, isWhatsAppGroupJid as t };
