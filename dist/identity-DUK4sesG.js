import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { l as normalizeE164 } from "./utils-sBTEdeml.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./text-utility-runtime-CaGXarh9.js";
//#region extensions/signal/src/normalize.ts
function normalizeSignalMessagingTarget(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return;
	let normalized = trimmed;
	if (normalizeLowercaseStringOrEmpty(normalized).startsWith("signal:")) normalized = normalized.slice(7).trim();
	if (!normalized) return;
	const lower = normalizeLowercaseStringOrEmpty(normalized);
	if (lower.startsWith("group:")) {
		const id = normalized.slice(6).trim();
		return id ? `group:${id}` : void 0;
	}
	if (lower.startsWith("username:")) {
		const id = normalized.slice(9).trim();
		return id ? normalizeLowercaseStringOrEmpty(`username:${id}`) : void 0;
	}
	if (lower.startsWith("u:")) {
		const id = normalized.slice(2).trim();
		return id ? normalizeLowercaseStringOrEmpty(`username:${id}`) : void 0;
	}
	if (lower.startsWith("uuid:")) {
		const id = normalized.slice(5).trim();
		return id ? normalizeLowercaseStringOrEmpty(id) : void 0;
	}
	return normalizeLowercaseStringOrEmpty(normalized);
}
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_COMPACT_PATTERN = /^[0-9a-f]{32}$/i;
function looksLikeSignalTargetId(raw, normalized) {
	const candidates = [raw, normalized ?? ""].map((value) => value.trim()).filter(Boolean);
	for (const candidate of candidates) {
		if (/^(signal:)?(group:|username:|u:)/i.test(candidate)) return true;
		if (/^(signal:)?uuid:/i.test(candidate)) {
			const stripped = candidate.replace(/^signal:/i, "").replace(/^uuid:/i, "").trim();
			if (!stripped) continue;
			if (UUID_PATTERN.test(stripped) || UUID_COMPACT_PATTERN.test(stripped)) return true;
			continue;
		}
		const withoutSignalPrefix = candidate.replace(/^signal:/i, "").trim();
		if (UUID_PATTERN.test(withoutSignalPrefix) || UUID_COMPACT_PATTERN.test(withoutSignalPrefix)) return true;
		if (/^\+?\d{3,}$/.test(withoutSignalPrefix)) return true;
	}
	return false;
}
//#endregion
//#region extensions/signal/src/uuid.ts
const UUID_HYPHENATED_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_COMPACT_RE = /^[0-9a-f]{32}$/i;
function looksLikeUuid(value) {
	if (UUID_HYPHENATED_RE.test(value) || UUID_COMPACT_RE.test(value)) return true;
	const compact = value.replace(/-/g, "");
	if (!/^[0-9a-f]+$/i.test(compact)) return false;
	return /[a-f]/i.test(compact);
}
//#endregion
//#region extensions/signal/src/identity.ts
function stripSignalPrefix(value) {
	return value.replace(/^signal:/i, "").trim();
}
function resolveSignalSender(params) {
	const sourceNumber = params.sourceNumber?.trim();
	if (sourceNumber) return {
		kind: "phone",
		raw: sourceNumber,
		e164: normalizeE164(sourceNumber)
	};
	const sourceUuid = params.sourceUuid?.trim();
	if (sourceUuid) return {
		kind: "uuid",
		raw: sourceUuid
	};
	return null;
}
function formatSignalSenderId(sender) {
	return sender.kind === "phone" ? sender.e164 : `uuid:${sender.raw}`;
}
function formatSignalSenderDisplay(sender) {
	return sender.kind === "phone" ? sender.e164 : `uuid:${sender.raw}`;
}
function formatSignalPairingIdLine(sender) {
	if (sender.kind === "phone") return `Your Signal number: ${sender.e164}`;
	return `Your Signal sender id: ${formatSignalSenderId(sender)}`;
}
function resolveSignalRecipient(sender) {
	return sender.kind === "phone" ? sender.e164 : sender.raw;
}
function resolveSignalPeerId(sender) {
	return sender.kind === "phone" ? sender.e164 : `uuid:${sender.raw}`;
}
function parseSignalAllowEntry(entry) {
	const trimmed = entry.trim();
	if (!trimmed) return null;
	if (trimmed === "*") return { kind: "any" };
	const stripped = stripSignalPrefix(trimmed);
	if (normalizeLowercaseStringOrEmpty(stripped).startsWith("uuid:")) {
		const raw = stripped.slice(5).trim();
		if (!raw) return null;
		return {
			kind: "uuid",
			raw
		};
	}
	if (looksLikeUuid(stripped)) return {
		kind: "uuid",
		raw: stripped
	};
	return {
		kind: "phone",
		e164: normalizeE164(stripped)
	};
}
function normalizeSignalAllowRecipient(entry) {
	const parsed = parseSignalAllowEntry(entry);
	if (!parsed || parsed.kind === "any") return;
	return parsed.kind === "phone" ? parsed.e164 : parsed.raw;
}
function isSignalSenderAllowed(sender, allowFrom) {
	if (allowFrom.length === 0) return false;
	const parsed = allowFrom.map(parseSignalAllowEntry).filter((entry) => entry !== null);
	if (parsed.some((entry) => entry.kind === "any")) return true;
	return parsed.some((entry) => {
		if (entry.kind === "phone" && sender.kind === "phone") return entry.e164 === sender.e164;
		if (entry.kind === "uuid" && sender.kind === "uuid") return entry.raw === sender.raw;
		return false;
	});
}
//#endregion
export { normalizeSignalAllowRecipient as a, resolveSignalSender as c, normalizeSignalMessagingTarget as d, isSignalSenderAllowed as i, looksLikeUuid as l, formatSignalSenderDisplay as n, resolveSignalPeerId as o, formatSignalSenderId as r, resolveSignalRecipient as s, formatSignalPairingIdLine as t, looksLikeSignalTargetId as u };
