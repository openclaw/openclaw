import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
import { r as logVerbose } from "./globals-2rjcRy6M.js";
import { n as listMessageReceiptPlatformIds, t as createMessageReceiptFromOutboundResults } from "./receipt-D4thzls4.js";
import "./string-coerce-runtime-B-Wo_S-q.js";
import { n as recordChannelActivity } from "./channel-activity-B22YB5W0.js";
import "./runtime-env-zJY-klAY.js";
import "./channel-inbound-CknlNatI.js";
import { t as formatLocationText } from "./location-KXRARpTH.js";
import "./channel-message-CBzgQfUC.js";
import { n as isWhatsAppNewsletterJid } from "./normalize-target-Dzyko5kl.js";
import "./normalize-DkIS7A5r.js";
import { o as toWhatsappJid, r as jidToE164, s as toWhatsappJidWithLid } from "./text-runtime-6sdl2e11.js";
import { t as buildQuotedMessageOptions } from "./quoted-message-BHLxto4r.js";
import { c as resolveComparableIdentity } from "./identity-N--G5NF8.js";
import { a as extractMessageContent, o as getContentType, s as normalizeMessageContent } from "./session.runtime-DWbLnKUJ.js";
//#region extensions/whatsapp/src/vcard.ts
const ALLOWED_VCARD_KEYS = new Set([
	"FN",
	"N",
	"TEL"
]);
function parseVcard(vcard) {
	if (!vcard) return { phones: [] };
	const lines = vcard.split(/\r?\n/);
	let nameFromN;
	let nameFromFn;
	const phones = [];
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) continue;
		const colonIndex = line.indexOf(":");
		if (colonIndex === -1) continue;
		const key = line.slice(0, colonIndex).toUpperCase();
		const rawValue = line.slice(colonIndex + 1).trim();
		if (!rawValue) continue;
		const baseKey = normalizeVcardKey(key);
		if (!baseKey || !ALLOWED_VCARD_KEYS.has(baseKey)) continue;
		const value = cleanVcardValue(rawValue);
		if (!value) continue;
		if (baseKey === "FN" && !nameFromFn) {
			nameFromFn = normalizeVcardName(value);
			continue;
		}
		if (baseKey === "N" && !nameFromN) {
			nameFromN = normalizeVcardName(value);
			continue;
		}
		if (baseKey === "TEL") {
			const phone = normalizeVcardPhone(value);
			if (phone) phones.push(phone);
		}
	}
	return {
		name: nameFromFn ?? nameFromN,
		phones
	};
}
function normalizeVcardKey(key) {
	const [primary] = key.split(";");
	if (!primary) return;
	const segments = primary.split(".");
	return segments[segments.length - 1] || void 0;
}
function cleanVcardValue(value) {
	return value.replace(/\\n/gi, " ").replace(/\\,/g, ",").replace(/\\;/g, ";").trim();
}
function normalizeVcardName(value) {
	return value.replace(/;/g, " ").replace(/\s+/g, " ").trim();
}
function normalizeVcardPhone(value) {
	const trimmed = value.trim();
	if (!trimmed) return "";
	if (normalizeLowercaseStringOrEmpty(trimmed).startsWith("tel:")) return trimmed.slice(4).trim();
	return trimmed;
}
//#endregion
//#region extensions/whatsapp/src/inbound/extract.ts
const MESSAGE_WRAPPER_KEYS = [
	"botInvokeMessage",
	"ephemeralMessage",
	"viewOnceMessage",
	"viewOnceMessageV2",
	"viewOnceMessageV2Extension",
	"documentWithCaptionMessage",
	"groupMentionedMessage"
];
const MESSAGE_CONTENT_KEYS = [
	"conversation",
	"extendedTextMessage",
	"imageMessage",
	"videoMessage",
	"audioMessage",
	"documentMessage",
	"stickerMessage",
	"locationMessage",
	"liveLocationMessage",
	"contactMessage",
	"contactsArrayMessage",
	"buttonsResponseMessage",
	"listResponseMessage",
	"templateButtonReplyMessage",
	"interactiveResponseMessage",
	"buttonsMessage",
	"listMessage"
];
function fallbackNormalizeMessageContent(message) {
	let current = message;
	while (current && typeof current === "object") {
		let unwrapped = false;
		for (const key of MESSAGE_WRAPPER_KEYS) {
			const candidate = current[key];
			if (candidate && typeof candidate === "object" && "message" in candidate && candidate.message) {
				current = candidate.message;
				unwrapped = true;
				break;
			}
		}
		if (!unwrapped) break;
	}
	return current;
}
function normalizeMessage(message) {
	if (typeof normalizeMessageContent === "function") return normalizeMessageContent(message);
	return fallbackNormalizeMessageContent(message);
}
function fallbackGetContentType(message) {
	const normalized = fallbackNormalizeMessageContent(message);
	if (!normalized || typeof normalized !== "object") return;
	for (const key of MESSAGE_CONTENT_KEYS) if (normalized[key] != null) return key;
}
function getMessageContentType(message) {
	if (typeof getContentType === "function") return getContentType(message);
	return fallbackGetContentType(message);
}
function extractMessage(message) {
	if (typeof extractMessageContent === "function") return extractMessageContent(message);
	const normalized = fallbackNormalizeMessageContent(message);
	const contentType = fallbackGetContentType(normalized);
	if (!normalized || !contentType || contentType === "conversation") return normalized;
	const candidate = normalized[contentType];
	return candidate && typeof candidate === "object" ? candidate : normalized;
}
function getFutureProofInnerMessage(message) {
	const contentType = getMessageContentType(message);
	const candidate = contentType ? message[contentType] : void 0;
	if (candidate && typeof candidate === "object" && "message" in candidate && candidate.message && typeof candidate.message === "object") {
		const inner = normalizeMessage(candidate.message);
		if (inner) {
			const innerType = getMessageContentType(inner);
			if (innerType && innerType !== contentType) return inner;
		}
	}
}
function buildMessageChain(message) {
	const chain = [];
	let current = normalizeMessage(message);
	while (current && chain.length < 4) {
		chain.push(current);
		current = getFutureProofInnerMessage(current);
	}
	return chain;
}
function unwrapMessage(message) {
	return buildMessageChain(message).at(-1);
}
function extractContextInfoFromMessage(message) {
	const contentType = getMessageContentType(message);
	const candidate = contentType ? message[contentType] : void 0;
	const contextInfo = candidate && typeof candidate === "object" && "contextInfo" in candidate ? candidate.contextInfo : void 0;
	if (contextInfo) return contextInfo;
	const fallback = message.extendedTextMessage?.contextInfo ?? message.imageMessage?.contextInfo ?? message.videoMessage?.contextInfo ?? message.documentMessage?.contextInfo ?? message.audioMessage?.contextInfo ?? message.stickerMessage?.contextInfo ?? message.buttonsResponseMessage?.contextInfo ?? message.listResponseMessage?.contextInfo ?? message.templateButtonReplyMessage?.contextInfo ?? message.interactiveResponseMessage?.contextInfo ?? message.buttonsMessage?.contextInfo ?? message.listMessage?.contextInfo;
	if (fallback) return fallback;
	for (const value of Object.values(message)) {
		if (!value || typeof value !== "object") continue;
		if ("contextInfo" in value) {
			const candidateContext = value.contextInfo;
			if (candidateContext) return candidateContext;
		}
		if ("message" in value) {
			const inner = value.message;
			if (inner) {
				const innerCtx = extractContextInfo(inner);
				if (innerCtx) return innerCtx;
			}
		}
	}
}
function extractContextInfo(message) {
	for (const candidate of buildMessageChain(message)) {
		const contextInfo = extractContextInfoFromMessage(candidate);
		if (contextInfo) return contextInfo;
	}
}
function extractMentionedJids(rawMessage) {
	const message = unwrapMessage(rawMessage);
	if (!message) return;
	const flattened = [
		message.extendedTextMessage?.contextInfo?.mentionedJid,
		message.imageMessage?.contextInfo?.mentionedJid,
		message.videoMessage?.contextInfo?.mentionedJid,
		message.documentMessage?.contextInfo?.mentionedJid,
		message.audioMessage?.contextInfo?.mentionedJid,
		message.stickerMessage?.contextInfo?.mentionedJid,
		message.buttonsResponseMessage?.contextInfo?.mentionedJid,
		message.listResponseMessage?.contextInfo?.mentionedJid
	].flatMap((arr) => arr ?? []).filter(Boolean);
	if (flattened.length === 0) return;
	return Array.from(new Set(flattened));
}
function extractText(rawMessage) {
	const message = unwrapMessage(rawMessage);
	if (!message) return;
	const extracted = extractMessage(message);
	const candidates = [message, extracted && extracted !== message ? extracted : void 0];
	for (const candidate of candidates) {
		if (!candidate) continue;
		if (typeof candidate.conversation === "string" && candidate.conversation.trim()) return candidate.conversation.trim();
		const extended = candidate.extendedTextMessage?.text;
		if (extended?.trim()) return extended.trim();
		const caption = candidate.imageMessage?.caption ?? candidate.videoMessage?.caption ?? candidate.documentMessage?.caption;
		if (caption?.trim()) return caption.trim();
	}
	const contactPlaceholder = extractContactPlaceholder(message) ?? (extracted && extracted !== message ? extractContactPlaceholder(extracted) : void 0);
	if (contactPlaceholder) return contactPlaceholder;
}
function extractMediaPlaceholder(rawMessage) {
	const message = unwrapMessage(rawMessage);
	if (!message) return;
	if (message.imageMessage) return "<media:image>";
	if (message.videoMessage) return "<media:video>";
	if (message.audioMessage) return "<media:audio>";
	if (message.documentMessage) return "<media:document>";
	if (message.stickerMessage) return "<media:sticker>";
}
function extractContactPlaceholder(rawMessage) {
	const contactContext = extractContactContext(rawMessage);
	if (!contactContext) return;
	if (contactContext.kind === "contact") return "<contact>";
	const suffix = contactContext.total === 1 ? "contact" : "contacts";
	return `<contacts: ${contactContext.total} ${suffix}>`;
}
function extractContactContext(rawMessage) {
	const message = unwrapMessage(rawMessage);
	if (!message) return;
	const contact = message.contactMessage ?? void 0;
	if (contact) {
		const { name, phones } = describeContact({
			displayName: contact.displayName,
			vcard: contact.vcard
		});
		return {
			kind: "contact",
			total: 1,
			contacts: [{
				name,
				phones
			}]
		};
	}
	const contactsArray = message.contactsArrayMessage?.contacts ?? void 0;
	if (!contactsArray || contactsArray.length === 0) return;
	return {
		kind: "contacts",
		total: contactsArray.length,
		contacts: contactsArray.map((entry) => describeContact({
			displayName: entry.displayName,
			vcard: entry.vcard
		}))
	};
}
function describeContact(input) {
	const displayName = (input.displayName ?? "").trim();
	const parsed = parseVcard(input.vcard ?? void 0);
	return {
		name: displayName || parsed.name,
		phones: parsed.phones
	};
}
function extractLocationData(rawMessage) {
	const message = unwrapMessage(rawMessage);
	if (!message) return null;
	const live = message.liveLocationMessage ?? void 0;
	if (live) {
		const latitudeRaw = live.degreesLatitude;
		const longitudeRaw = live.degreesLongitude;
		if (latitudeRaw != null && longitudeRaw != null) {
			const latitude = latitudeRaw;
			const longitude = longitudeRaw;
			if (Number.isFinite(latitude) && Number.isFinite(longitude)) return {
				latitude,
				longitude,
				accuracy: live.accuracyInMeters ?? void 0,
				caption: live.caption ?? void 0,
				source: "live",
				isLive: true
			};
		}
	}
	const location = message.locationMessage ?? void 0;
	if (location) {
		const latitudeRaw = location.degreesLatitude;
		const longitudeRaw = location.degreesLongitude;
		if (latitudeRaw != null && longitudeRaw != null) {
			const latitude = latitudeRaw;
			const longitude = longitudeRaw;
			if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
				const isLive = Boolean(location.isLive);
				return {
					latitude,
					longitude,
					accuracy: location.accuracyInMeters ?? void 0,
					name: location.name ?? void 0,
					address: location.address ?? void 0,
					caption: location.comment ?? void 0,
					source: isLive ? "live" : location.name || location.address ? "place" : "pin",
					isLive
				};
			}
		}
	}
	return null;
}
function describeReplyContext(rawMessage) {
	const message = unwrapMessage(rawMessage);
	if (!message) return null;
	const contextInfo = extractContextInfo(message);
	const quoted = normalizeMessage(contextInfo?.quotedMessage);
	if (!quoted) return null;
	const location = extractLocationData(quoted);
	const locationText = location ? formatLocationText(location) : void 0;
	let body = [extractText(quoted), locationText].filter(Boolean).join("\n").trim();
	if (!body) body = extractMediaPlaceholder(quoted);
	if (!body) {
		const quotedType = quoted ? getMessageContentType(quoted) : void 0;
		logVerbose(`Quoted message missing extractable body${quotedType ? ` (type ${quotedType})` : ""}`);
		return null;
	}
	const senderJid = contextInfo?.participant ?? void 0;
	const sender = resolveComparableIdentity({
		jid: senderJid,
		label: senderJid ? jidToE164(senderJid) ?? senderJid : "unknown sender"
	});
	return {
		id: contextInfo?.stanzaId || void 0,
		body,
		sender
	};
}
function hasInteractiveResponseContent(message) {
	if (!message) return false;
	return Boolean(message.buttonsResponseMessage || message.listResponseMessage || message.templateButtonReplyMessage || message.interactiveResponseMessage);
}
/**
* Fast check that a Baileys message carries user-visible inbound content
* (text, media, contact, location, button/list selection). Returns false for
* protocol/receipt/typing notifications that arrive on the same
* `messages.upsert` stream as real messages but should not trigger pairing
* access-control side effects.
*/
function hasInboundUserContent(rawMessage) {
	if (!rawMessage) return false;
	if (extractText(rawMessage)) return true;
	if (extractMediaPlaceholder(rawMessage)) return true;
	if (extractLocationData(rawMessage)) return true;
	for (const candidate of buildMessageChain(rawMessage)) if (hasInteractiveResponseContent(candidate)) return true;
	return false;
}
//#endregion
//#region extensions/whatsapp/src/inbound/outbound-mentions.ts
const CODE_FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;
const OUTBOUND_MENTION_RE = /@(\+?\d+)/g;
const KNOWN_USER_JID_RE = /^(\d+)(?::\d+)?@(s\.whatsapp\.net|hosted|lid|hosted\.lid|c\.us)$/i;
const PHONE_JID_DOMAIN_RE = /^(s\.whatsapp\.net|hosted|c\.us)$/i;
const LID_JID_DOMAIN_RE = /^(lid|hosted\.lid)$/i;
function isWhatsAppGroupJid(jid) {
	return jid.endsWith("@g.us");
}
function mayContainWhatsAppOutboundMention(text) {
	return /@\+?\d/.test(text);
}
function collectCodeRanges(text) {
	const ranges = [];
	for (const match of text.matchAll(CODE_FENCE_RE)) ranges.push({
		start: match.index,
		end: match.index + match[0].length
	});
	for (const match of text.matchAll(INLINE_CODE_RE)) {
		const start = match.index;
		if (ranges.some((range) => start >= range.start && start < range.end)) continue;
		ranges.push({
			start,
			end: start + match[0].length
		});
	}
	return ranges.toSorted((a, b) => a.start - b.start);
}
function isInRange(index, ranges) {
	return ranges.some((range) => index >= range.start && index < range.end);
}
function normalizeKnownUserJid(value) {
	const trimmed = value.replace(/^whatsapp:/i, "").trim();
	const jidMatch = trimmed.match(KNOWN_USER_JID_RE);
	if (jidMatch) {
		const domain = jidMatch[2].toLowerCase() === "c.us" ? "s.whatsapp.net" : jidMatch[2].toLowerCase();
		return `${jidMatch[1]}@${domain}`;
	}
	const digits = trimmed.startsWith("+") ? trimmed.replace(/\D/g, "") : /^\d+$/.test(trimmed) ? trimmed : "";
	return digits ? `${digits}@s.whatsapp.net` : null;
}
function extractKnownJidParts(value) {
	const normalized = normalizeKnownUserJid(value);
	if (!normalized) return null;
	const match = normalized.match(/^(\d+)@(.+)$/);
	return match ? {
		user: match[1],
		domain: match[2]
	} : null;
}
function extractPhoneDigits(value) {
	if (!value) return null;
	const trimmed = value.replace(/^whatsapp:/i, "").trim();
	if (trimmed.startsWith("+") || /^\d+$/.test(trimmed)) return trimmed.replace(/\D/g, "") || null;
	const parts = extractKnownJidParts(trimmed);
	return parts && PHONE_JID_DOMAIN_RE.test(parts.domain) ? parts.user : null;
}
function extractLidDigits(value) {
	if (!value) return null;
	const parts = extractKnownJidParts(value);
	return parts && LID_JID_DOMAIN_RE.test(parts.domain) ? parts.user : null;
}
function isLidJid(jid) {
	const parts = extractKnownJidParts(jid);
	return Boolean(parts && LID_JID_DOMAIN_RE.test(parts.domain));
}
function lidReplacementText(jid) {
	const parts = extractKnownJidParts(jid);
	if (!parts || !LID_JID_DOMAIN_RE.test(parts.domain)) return;
	return `@${parts.user}`;
}
function participantValues(participant) {
	return typeof participant === "string" ? { id: participant } : participant;
}
function chooseMentionJid(participant) {
	const values = participantValues(participant);
	const idJid = normalizeKnownUserJid(values.id ?? "");
	const lidJid = normalizeKnownUserJid(values.lid ?? "");
	return (idJid && isLidJid(idJid) ? idJid : null) ?? (lidJid && isLidJid(lidJid) ? lidJid : null) ?? idJid ?? lidJid ?? normalizeKnownUserJid(values.phoneNumber ?? "") ?? normalizeKnownUserJid(values.e164 ?? "");
}
function buildMentionTargetMaps(participants) {
	const byPhone = /* @__PURE__ */ new Map();
	const byLid = /* @__PURE__ */ new Map();
	for (const participant of participants) {
		const mentionJid = chooseMentionJid(participant);
		if (!mentionJid) continue;
		const target = {
			mentionJid,
			...isLidJid(mentionJid) ? { replacementText: lidReplacementText(mentionJid) } : {}
		};
		const values = participantValues(participant);
		for (const value of [
			values.id,
			values.phoneNumber,
			values.e164
		]) {
			const digits = extractPhoneDigits(value);
			if (digits && !byPhone.has(digits)) byPhone.set(digits, target);
		}
		for (const value of [values.id, values.lid]) {
			const digits = extractLidDigits(value);
			if (digits && !byLid.has(digits)) byLid.set(digits, target);
		}
	}
	return {
		byPhone,
		byLid
	};
}
function shouldSkipMentionAt(text, index, end, codeRanges) {
	if (isInRange(index, codeRanges)) return true;
	const previous = index > 0 ? text[index - 1] : "";
	const next = text[end] ?? "";
	return Boolean(previous && /[\w@]/.test(previous) || next && /[\w@]/.test(next));
}
function resolveWhatsAppOutboundMentions(params) {
	if (!isWhatsAppGroupJid(params.chatJid) || !mayContainWhatsAppOutboundMention(params.text) || !params.participants?.length) return {
		text: params.text,
		mentionedJids: []
	};
	const { byPhone, byLid } = buildMentionTargetMaps(params.participants);
	if (byPhone.size === 0 && byLid.size === 0) return {
		text: params.text,
		mentionedJids: []
	};
	const codeRanges = collectCodeRanges(params.text);
	const replacements = [];
	const mentionedJids = [];
	const seenMentionJids = /* @__PURE__ */ new Set();
	for (const match of params.text.matchAll(OUTBOUND_MENTION_RE)) {
		const start = match.index;
		const token = match[0];
		if (shouldSkipMentionAt(params.text, start, start + token.length, codeRanges)) continue;
		const digits = match[1].replace(/\D/g, "");
		const target = token.startsWith("@+") ? byPhone.get(digits) ?? byLid.get(digits) : byLid.get(digits) ?? byPhone.get(digits);
		if (!target) continue;
		if (!seenMentionJids.has(target.mentionJid)) {
			seenMentionJids.add(target.mentionJid);
			mentionedJids.push(target.mentionJid);
		}
		if (target.replacementText && target.replacementText !== token) replacements.push({
			start,
			end: start + token.length,
			text: target.replacementText
		});
	}
	if (replacements.length === 0) return {
		text: params.text,
		mentionedJids
	};
	let text = "";
	let cursor = 0;
	for (const replacement of replacements) {
		text += params.text.slice(cursor, replacement.start);
		text += replacement.text;
		cursor = replacement.end;
	}
	text += params.text.slice(cursor);
	return {
		text,
		mentionedJids
	};
}
function addWhatsAppOutboundMentionsToContent(content, mentionedJids) {
	return mentionedJids.length > 0 ? {
		...content,
		mentions: [...mentionedJids]
	} : content;
}
//#endregion
//#region extensions/whatsapp/src/inbound/send-result.ts
function resolveWhatsAppReceiptKind(kind) {
	if (kind === "media" || kind === "text") return kind;
	return "unknown";
}
function toReceiptSourceResult(key) {
	return {
		channel: "whatsapp",
		messageId: key.id,
		...key.remoteJid ? { toJid: key.remoteJid } : {},
		meta: {
			fromMe: key.fromMe,
			participant: key.participant
		}
	};
}
function createWhatsAppSendReceipt(kind, keys) {
	return createMessageReceiptFromOutboundResults({
		kind: resolveWhatsAppReceiptKind(kind),
		results: keys.map(toReceiptSourceResult)
	});
}
function normalizeKey(key) {
	const id = typeof key?.id === "string" ? key.id.trim() : "";
	if (!id) return;
	return {
		id,
		remoteJid: key?.remoteJid,
		fromMe: key?.fromMe,
		participant: key?.participant
	};
}
function normalizeWhatsAppSendResult(result, kind) {
	const key = normalizeKey(result?.key);
	return {
		kind,
		messageId: key?.id ?? "unknown",
		receipt: createWhatsAppSendReceipt(kind, key ? [key] : []),
		keys: key ? [key] : [],
		providerAccepted: Boolean(key)
	};
}
function combineWhatsAppSendResults(kind, results) {
	const messageIds = [...new Set(results.flatMap(listWhatsAppSendResultMessageIds))];
	const keys = results.flatMap((result) => result.keys);
	return {
		kind,
		messageId: messageIds[0] ?? "unknown",
		receipt: createWhatsAppSendReceipt(kind, keys),
		keys,
		providerAccepted: results.some((result) => result.providerAccepted)
	};
}
function listWhatsAppSendResultMessageIds(result) {
	const receiptIds = result.receipt ? listMessageReceiptPlatformIds(result.receipt) : [];
	if (receiptIds.length > 0) return receiptIds;
	const keyIds = result.keys.map((key) => key.id.trim()).filter(Boolean);
	if (keyIds.length > 0) return [...new Set(keyIds)];
	return [];
}
//#endregion
//#region extensions/whatsapp/src/inbound/send-api.ts
function recordWhatsAppOutbound(accountId) {
	recordChannelActivity({
		channel: "whatsapp",
		accountId,
		direction: "outbound"
	});
}
function createWebSendApi(params) {
	const resolveOutboundJid = (recipient) => params.authDir ? toWhatsappJidWithLid(recipient, { authDir: params.authDir }) : toWhatsappJid(recipient);
	const resolveMentions = async (jid, text) => params.resolveOutboundMentions ? await params.resolveOutboundMentions({
		jid,
		text
	}) : {
		text,
		mentionedJids: []
	};
	return {
		sendMessage: async (to, text, mediaBuffer, mediaType, sendOptions) => {
			const jid = resolveOutboundJid(to);
			let payload;
			if (mediaBuffer) mediaType ??= "application/octet-stream";
			const shouldSendAudioText = Boolean(mediaBuffer && mediaType?.startsWith("audio/") && text.trim());
			const resolvedPayloadText = shouldSendAudioText ? {
				text,
				mentionedJids: []
			} : await resolveMentions(jid, text);
			if (mediaBuffer && mediaType) if (mediaType.startsWith("image/")) payload = {
				image: mediaBuffer,
				caption: resolvedPayloadText.text || void 0,
				mimetype: mediaType
			};
			else if (mediaType.startsWith("audio/")) payload = {
				audio: mediaBuffer,
				ptt: true,
				mimetype: mediaType
			};
			else if (mediaType.startsWith("video/")) {
				const gifPlayback = sendOptions?.gifPlayback;
				payload = {
					video: mediaBuffer,
					caption: resolvedPayloadText.text || void 0,
					mimetype: mediaType,
					...gifPlayback ? { gifPlayback: true } : {}
				};
			} else payload = {
				document: mediaBuffer,
				fileName: sendOptions?.fileName?.trim() || "file",
				caption: resolvedPayloadText.text || void 0,
				mimetype: mediaType
			};
			else payload = { text: resolvedPayloadText.text };
			payload = addWhatsAppOutboundMentionsToContent(payload, resolvedPayloadText.mentionedJids);
			const quotedOpts = buildQuotedMessageOptions({
				messageId: sendOptions?.quotedMessageKey?.id,
				remoteJid: sendOptions?.quotedMessageKey?.remoteJid,
				fromMe: sendOptions?.quotedMessageKey?.fromMe,
				participant: sendOptions?.quotedMessageKey?.participant,
				messageText: sendOptions?.quotedMessageKey?.messageText
			});
			const results = [normalizeWhatsAppSendResult(quotedOpts ? await params.sock.sendMessage(jid, payload, quotedOpts) : await params.sock.sendMessage(jid, payload), mediaBuffer ? "media" : "text")];
			if (shouldSendAudioText) {
				const resolvedAudioText = await resolveMentions(jid, text);
				const textPayload = addWhatsAppOutboundMentionsToContent({ text: resolvedAudioText.text }, resolvedAudioText.mentionedJids);
				const textResult = quotedOpts ? await params.sock.sendMessage(jid, textPayload, quotedOpts) : await params.sock.sendMessage(jid, textPayload);
				results.push(normalizeWhatsAppSendResult(textResult, "text"));
			}
			recordWhatsAppOutbound(sendOptions?.accountId ?? params.defaultAccountId);
			return combineWhatsAppSendResults(mediaBuffer ? "media" : "text", results);
		},
		sendPoll: async (to, poll) => {
			const jid = resolveOutboundJid(to);
			const result = await params.sock.sendMessage(jid, { poll: {
				name: poll.question,
				values: poll.options,
				selectableCount: poll.maxSelections ?? 1
			} });
			recordWhatsAppOutbound(params.defaultAccountId);
			return normalizeWhatsAppSendResult(result, "poll");
		},
		sendReaction: async (chatJid, messageId, emoji, fromMe, participant) => {
			const jid = toWhatsappJid(chatJid);
			return normalizeWhatsAppSendResult(await params.sock.sendMessage(jid, { react: {
				text: emoji,
				key: {
					remoteJid: jid,
					id: messageId,
					fromMe,
					participant: participant ? toWhatsappJid(participant) : void 0
				}
			} }), "reaction");
		},
		sendComposingTo: async (to) => {
			const jid = resolveOutboundJid(to);
			if (isWhatsAppNewsletterJid(jid)) return;
			await params.sock.sendPresenceUpdate("composing", jid);
		}
	};
}
//#endregion
export { mayContainWhatsAppOutboundMention as a, extractContactContext as c, extractMediaPlaceholder as d, extractMentionedJids as f, addWhatsAppOutboundMentionsToContent as i, extractContextInfo as l, hasInboundUserContent as m, listWhatsAppSendResultMessageIds as n, resolveWhatsAppOutboundMentions as o, extractText as p, normalizeWhatsAppSendResult as r, describeReplyContext as s, createWebSendApi as t, extractLocationData as u };
