import { C as sleep, F as shouldLogVerbose, M as logVerbose, T as toWhatsappJid, V as getChildLogger, f as isSelfChatMode, m as normalizeE164, p as jidToE164, r as clamp, v as resolveJidToE164 } from "./utils-BKDT474X.js";
import { An as createDedupeCache, At as sleepWithAbort, Cn as resolveInboundDebounceMs, Cr as buildMentionRegexes, Mn as shouldComputeCommandAuthorized, Sn as createInboundDebouncer, Tn as resolveEnvelopeFormatOptions, Tr as enqueueSystemEvent, _n as resolveOpenProviderRuntimeGroupPolicy, bn as dispatchReplyWithBufferedBlockDispatcher, dn as buildPairingReply, fn as resolveMentionGating, gn as resolveDefaultGroupPolicy, hn as recordPendingHistoryEntryIfEnabled, jn as hasControlCommand, kt as computeBackoff, mn as buildHistoryContextFromEntries, pn as DEFAULT_GROUP_HISTORY_LIMIT, t as getReplyFromConfig, vn as warnMissingProviderGroupPolicyFallbackOnce, vt as normalizeGroupActivation, wn as formatInboundEnvelope, wr as normalizeMentionText, yn as shouldAckReactionForWhatsApp, yt as parseActivationCommand } from "./reply-D8YvfZps.js";
import { f as defaultRuntime, t as createSubsystemLogger } from "./subsystem-LTWJBEIv.js";
import { a as buildGroupHistoryKey, n as DEFAULT_MAIN_KEY, r as buildAgentMainSessionKey, s as normalizeAgentId } from "./session-key-D5gwKk5E.js";
import { zt as loadConfig } from "./model-selection-DILdVnl8.js";
import { t as formatCliCommand } from "./command-format-ChfKqObn.js";
import { a as resolveChannelGroupRequireMention, i as resolveChannelGroupPolicy } from "./dock-C2VnAw6v.js";
import { t as finalizeInboundContext } from "./inbound-context-DfCXi6fk.js";
import { d as registerUnhandledRejectionHandler } from "./runner-7gZudimw.js";
import { r as saveMediaBuffer } from "./store-DLi2fq1F.js";
import { c as loadSessionStore, d as recordSessionMetaFromInbound, m as updateLastRoute, ot as resolveGroupSessionKey, u as readSessionUpdatedAt } from "./sessions-DUzDEcXs.js";
import { i as resolveWhatsAppAccount, p as readWebSelfId, s as getWebAuthAgeMs } from "./accounts-BDIC1FjT.js";
import { l as resolveStorePath } from "./paths-B_bX6Iw-.js";
import { t as getAgentScopedMediaLocalRoots } from "./local-roots-BTCvOgYJ.js";
import { s as upsertChannelPairingRequest } from "./pairing-store-BTqK0Qm4.js";
import { r as formatDurationPrecise } from "./format-duration-Cjm12lPa.js";
import { G as formatLocationText, K as toLocationContext } from "./send-N61MHKq6.js";
import { c as resolveIdentityNamePrefix, l as resolveMessagePrefix, t as createReplyPrefixOptions } from "./reply-prefix-CdgjH0e2.js";
import { c as resolveChunkMode, i as chunkMarkdownTextWithMode, l as resolveTextChunkLimit } from "./chunk-Dnv6wXws.js";
import { n as resolveMarkdownTableMode } from "./markdown-tables-ncF_g1sJ.js";
import { a as loadWebMedia } from "./ir-DvzfoshW.js";
import { c as readStoreAllowFromForDmPolicy, d as resolveDmGroupAccessWithLists, u as resolveDmGroupAccessWithCommandGate } from "./pi-tools.policy-B-oYnxAN.js";
import { n as recordChannelActivity } from "./channel-activity-Cp9DXV4g.js";
import { t as convertMarkdownTables } from "./tables-e1ODH_83.js";
import { n as resolveAgentRoute, t as buildAgentSessionKey } from "./resolve-route-Vqi5MkqW.js";
import { r as setActiveWebListener } from "./active-listener-uCRvNWFP.js";
import { i as markdownToWhatsApp, r as sendReactionWhatsApp } from "./outbound-CAzCOQ_2.js";
import { i as waitForWaConnection, n as formatError, r as getStatusCode, t as createWaSocket } from "./session-DbyNFR6g.js";
import { randomUUID } from "node:crypto";
import { DisconnectReason, downloadMediaMessage, extractMessageContent, getContentType, isJidGroup, normalizeMessageContent } from "@whiskeysockets/baileys";

//#region src/web/auto-reply/constants.ts
const DEFAULT_WEB_MEDIA_BYTES = 5 * 1024 * 1024;

//#endregion
//#region src/web/reconnect.ts
const DEFAULT_HEARTBEAT_SECONDS = 60;
const DEFAULT_RECONNECT_POLICY = {
	initialMs: 2e3,
	maxMs: 3e4,
	factor: 1.8,
	jitter: .25,
	maxAttempts: 12
};
function resolveHeartbeatSeconds(cfg, overrideSeconds) {
	const candidate = overrideSeconds ?? cfg.web?.heartbeatSeconds;
	if (typeof candidate === "number" && candidate > 0) return candidate;
	return DEFAULT_HEARTBEAT_SECONDS;
}
function resolveReconnectPolicy(cfg, overrides) {
	const reconnectOverrides = cfg.web?.reconnect ?? {};
	const overrideConfig = overrides ?? {};
	const merged = {
		...DEFAULT_RECONNECT_POLICY,
		...reconnectOverrides,
		...overrideConfig
	};
	merged.initialMs = Math.max(250, merged.initialMs);
	merged.maxMs = Math.max(merged.initialMs, merged.maxMs);
	merged.factor = clamp(merged.factor, 1.1, 10);
	merged.jitter = clamp(merged.jitter, 0, 1);
	merged.maxAttempts = Math.max(0, Math.floor(merged.maxAttempts));
	return merged;
}
function newConnectionId() {
	return randomUUID();
}

//#endregion
//#region src/web/auto-reply/loggers.ts
const whatsappLog = createSubsystemLogger("gateway/channels/whatsapp");
const whatsappInboundLog = whatsappLog.child("inbound");
const whatsappOutboundLog = whatsappLog.child("outbound");
const whatsappHeartbeatLog = whatsappLog.child("heartbeat");

//#endregion
//#region src/cli/wait.ts
function waitForever() {
	setInterval(() => {}, 1e6).unref();
	return new Promise(() => {});
}

//#endregion
//#region src/web/inbound/dedupe.ts
const recentInboundMessages = createDedupeCache({
	ttlMs: 20 * 6e4,
	maxSize: 5e3
});
function isRecentInboundMessage(key) {
	return recentInboundMessages.check(key);
}

//#endregion
//#region src/web/vcard.ts
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
	if (trimmed.toLowerCase().startsWith("tel:")) return trimmed.slice(4).trim();
	return trimmed;
}

//#endregion
//#region src/web/inbound/extract.ts
function unwrapMessage$1(message) {
	return normalizeMessageContent(message);
}
function extractContextInfo(message) {
	if (!message) return;
	const contentType = getContentType(message);
	const candidate = contentType ? message[contentType] : void 0;
	const contextInfo = candidate && typeof candidate === "object" && "contextInfo" in candidate ? candidate.contextInfo : void 0;
	if (contextInfo) return contextInfo;
	const fallback = message.extendedTextMessage?.contextInfo ?? message.imageMessage?.contextInfo ?? message.videoMessage?.contextInfo ?? message.documentMessage?.contextInfo ?? message.audioMessage?.contextInfo ?? message.stickerMessage?.contextInfo ?? message.buttonsResponseMessage?.contextInfo ?? message.listResponseMessage?.contextInfo ?? message.templateButtonReplyMessage?.contextInfo ?? message.interactiveResponseMessage?.contextInfo ?? message.buttonsMessage?.contextInfo ?? message.listMessage?.contextInfo;
	if (fallback) return fallback;
	for (const value of Object.values(message)) {
		if (!value || typeof value !== "object") continue;
		if (!("contextInfo" in value)) continue;
		const candidateContext = value.contextInfo;
		if (candidateContext) return candidateContext;
	}
}
function extractMentionedJids(rawMessage) {
	const message = unwrapMessage$1(rawMessage);
	if (!message) return;
	const flattened = [
		message.extendedTextMessage?.contextInfo?.mentionedJid,
		message.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.contextInfo?.mentionedJid,
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
	const message = unwrapMessage$1(rawMessage);
	if (!message) return;
	const extracted = extractMessageContent(message);
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
	const message = unwrapMessage$1(rawMessage);
	if (!message) return;
	if (message.imageMessage) return "<media:image>";
	if (message.videoMessage) return "<media:video>";
	if (message.audioMessage) return "<media:audio>";
	if (message.documentMessage) return "<media:document>";
	if (message.stickerMessage) return "<media:sticker>";
}
function extractContactPlaceholder(rawMessage) {
	const message = unwrapMessage$1(rawMessage);
	if (!message) return;
	const contact = message.contactMessage ?? void 0;
	if (contact) {
		const { name, phones } = describeContact({
			displayName: contact.displayName,
			vcard: contact.vcard
		});
		return formatContactPlaceholder(name, phones);
	}
	const contactsArray = message.contactsArrayMessage?.contacts ?? void 0;
	if (!contactsArray || contactsArray.length === 0) return;
	return formatContactsPlaceholder(contactsArray.map((entry) => describeContact({
		displayName: entry.displayName,
		vcard: entry.vcard
	})).map((entry) => formatContactLabel(entry.name, entry.phones)).filter((value) => Boolean(value)), contactsArray.length);
}
function describeContact(input) {
	const displayName = (input.displayName ?? "").trim();
	const parsed = parseVcard(input.vcard ?? void 0);
	return {
		name: displayName || parsed.name,
		phones: parsed.phones
	};
}
function formatContactPlaceholder(name, phones) {
	const label = formatContactLabel(name, phones);
	if (!label) return "<contact>";
	return `<contact: ${label}>`;
}
function formatContactsPlaceholder(labels, total) {
	const cleaned = labels.map((label) => label.trim()).filter(Boolean);
	if (cleaned.length === 0) return `<contacts: ${total} ${total === 1 ? "contact" : "contacts"}>`;
	const remaining = Math.max(total - cleaned.length, 0);
	const suffix = remaining > 0 ? ` +${remaining} more` : "";
	return `<contacts: ${cleaned.join(", ")}${suffix}>`;
}
function formatContactLabel(name, phones) {
	const parts = [name, formatPhoneList(phones)].filter((value) => Boolean(value));
	if (parts.length === 0) return;
	return parts.join(", ");
}
function formatPhoneList(phones) {
	const cleaned = phones?.map((phone) => phone.trim()).filter(Boolean) ?? [];
	if (cleaned.length === 0) return;
	const { shown, remaining } = summarizeList(cleaned, cleaned.length, 1);
	const [primary] = shown;
	if (!primary) return;
	if (remaining === 0) return primary;
	return `${primary} (+${remaining} more)`;
}
function summarizeList(values, total, maxShown) {
	const shown = values.slice(0, maxShown);
	return {
		shown,
		remaining: Math.max(total - shown.length, 0)
	};
}
function extractLocationData(rawMessage) {
	const message = unwrapMessage$1(rawMessage);
	if (!message) return null;
	const live = message.liveLocationMessage ?? void 0;
	if (live) {
		const latitudeRaw = live.degreesLatitude;
		const longitudeRaw = live.degreesLongitude;
		if (latitudeRaw != null && longitudeRaw != null) {
			const latitude = Number(latitudeRaw);
			const longitude = Number(longitudeRaw);
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
			const latitude = Number(latitudeRaw);
			const longitude = Number(longitudeRaw);
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
	const message = unwrapMessage$1(rawMessage);
	if (!message) return null;
	const contextInfo = extractContextInfo(message);
	const quoted = normalizeMessageContent(contextInfo?.quotedMessage);
	if (!quoted) return null;
	const location = extractLocationData(quoted);
	const locationText = location ? formatLocationText(location) : void 0;
	let body = [extractText(quoted), locationText].filter(Boolean).join("\n").trim();
	if (!body) body = extractMediaPlaceholder(quoted);
	if (!body) {
		const quotedType = quoted ? getContentType(quoted) : void 0;
		logVerbose(`Quoted message missing extractable body${quotedType ? ` (type ${quotedType})` : ""}`);
		return null;
	}
	const senderJid = contextInfo?.participant ?? void 0;
	const senderE164 = senderJid ? jidToE164(senderJid) ?? senderJid : void 0;
	const sender = senderE164 ?? "unknown sender";
	return {
		id: contextInfo?.stanzaId ? String(contextInfo.stanzaId) : void 0,
		body,
		sender,
		senderJid,
		senderE164
	};
}

//#endregion
//#region src/web/inbound/access-control.ts
const PAIRING_REPLY_HISTORY_GRACE_MS = 3e4;
function resolveWhatsAppRuntimeGroupPolicy(params) {
	return resolveOpenProviderRuntimeGroupPolicy({
		providerConfigPresent: params.providerConfigPresent,
		groupPolicy: params.groupPolicy,
		defaultGroupPolicy: params.defaultGroupPolicy
	});
}
async function checkInboundAccessControl(params) {
	const cfg = loadConfig();
	const account = resolveWhatsAppAccount({
		cfg,
		accountId: params.accountId
	});
	const dmPolicy = account.dmPolicy ?? "pairing";
	const configuredAllowFrom = account.allowFrom ?? [];
	const storeAllowFrom = await readStoreAllowFromForDmPolicy({
		provider: "whatsapp",
		accountId: account.accountId,
		dmPolicy
	});
	const defaultAllowFrom = configuredAllowFrom.length === 0 && params.selfE164 ? [params.selfE164] : [];
	const dmAllowFrom = configuredAllowFrom.length > 0 ? configuredAllowFrom : defaultAllowFrom;
	const groupAllowFrom = account.groupAllowFrom ?? (configuredAllowFrom.length > 0 ? configuredAllowFrom : void 0);
	const isSamePhone = params.from === params.selfE164;
	const isSelfChat = account.selfChatMode ?? isSelfChatMode(params.selfE164, configuredAllowFrom);
	const pairingGraceMs = typeof params.pairingGraceMs === "number" && params.pairingGraceMs > 0 ? params.pairingGraceMs : PAIRING_REPLY_HISTORY_GRACE_MS;
	const suppressPairingReply = typeof params.connectedAtMs === "number" && typeof params.messageTimestampMs === "number" && params.messageTimestampMs < params.connectedAtMs - pairingGraceMs;
	const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
	const { groupPolicy, providerMissingFallbackApplied } = resolveWhatsAppRuntimeGroupPolicy({
		providerConfigPresent: cfg.channels?.whatsapp !== void 0,
		groupPolicy: account.groupPolicy,
		defaultGroupPolicy
	});
	warnMissingProviderGroupPolicyFallbackOnce({
		providerMissingFallbackApplied,
		providerKey: "whatsapp",
		accountId: account.accountId,
		log: (message) => logVerbose(message)
	});
	const normalizedDmSender = normalizeE164(params.from);
	const normalizedGroupSender = typeof params.senderE164 === "string" ? normalizeE164(params.senderE164) : null;
	const access = resolveDmGroupAccessWithLists({
		isGroup: params.group,
		dmPolicy,
		groupPolicy,
		allowFrom: params.group ? configuredAllowFrom : dmAllowFrom,
		groupAllowFrom,
		storeAllowFrom,
		isSenderAllowed: (allowEntries) => {
			if (allowEntries.includes("*")) return true;
			const normalizedEntrySet = new Set(allowEntries.map((entry) => normalizeE164(String(entry))).filter((entry) => Boolean(entry)));
			if (!params.group && isSamePhone) return true;
			return params.group ? Boolean(normalizedGroupSender && normalizedEntrySet.has(normalizedGroupSender)) : normalizedEntrySet.has(normalizedDmSender);
		}
	});
	if (params.group && access.decision !== "allow") {
		if (access.reason === "groupPolicy=disabled") logVerbose("Blocked group message (groupPolicy: disabled)");
		else if (access.reason === "groupPolicy=allowlist (empty allowlist)") logVerbose("Blocked group message (groupPolicy: allowlist, no groupAllowFrom)");
		else logVerbose(`Blocked group message from ${params.senderE164 ?? "unknown sender"} (groupPolicy: allowlist)`);
		return {
			allowed: false,
			shouldMarkRead: false,
			isSelfChat,
			resolvedAccountId: account.accountId
		};
	}
	if (!params.group) {
		if (params.isFromMe && !isSamePhone) {
			logVerbose("Skipping outbound DM (fromMe); no pairing reply needed.");
			return {
				allowed: false,
				shouldMarkRead: false,
				isSelfChat,
				resolvedAccountId: account.accountId
			};
		}
		if (access.decision === "block" && access.reason === "dmPolicy=disabled") {
			logVerbose("Blocked dm (dmPolicy: disabled)");
			return {
				allowed: false,
				shouldMarkRead: false,
				isSelfChat,
				resolvedAccountId: account.accountId
			};
		}
		if (access.decision === "pairing" && !isSamePhone) {
			const candidate = params.from;
			if (suppressPairingReply) logVerbose(`Skipping pairing reply for historical DM from ${candidate}.`);
			else {
				const { code, created } = await upsertChannelPairingRequest({
					channel: "whatsapp",
					id: candidate,
					accountId: account.accountId,
					meta: { name: (params.pushName ?? "").trim() || void 0 }
				});
				if (created) {
					logVerbose(`whatsapp pairing request sender=${candidate} name=${params.pushName ?? "unknown"}`);
					try {
						await params.sock.sendMessage(params.remoteJid, { text: buildPairingReply({
							channel: "whatsapp",
							idLine: `Your WhatsApp phone number: ${candidate}`,
							code
						}) });
					} catch (err) {
						logVerbose(`whatsapp pairing reply failed for ${candidate}: ${String(err)}`);
					}
				}
			}
			return {
				allowed: false,
				shouldMarkRead: false,
				isSelfChat,
				resolvedAccountId: account.accountId
			};
		}
		if (access.decision !== "allow") {
			logVerbose(`Blocked unauthorized sender ${params.from} (dmPolicy=${dmPolicy})`);
			return {
				allowed: false,
				shouldMarkRead: false,
				isSelfChat,
				resolvedAccountId: account.accountId
			};
		}
	}
	return {
		allowed: true,
		shouldMarkRead: true,
		isSelfChat,
		resolvedAccountId: account.accountId
	};
}

//#endregion
//#region src/web/inbound/media.ts
function unwrapMessage(message) {
	return normalizeMessageContent(message);
}
/**
* Resolve the MIME type for an inbound media message.
* Falls back to WhatsApp's standard formats when Baileys omits the MIME.
*/
function resolveMediaMimetype(message) {
	const explicit = message.imageMessage?.mimetype ?? message.videoMessage?.mimetype ?? message.documentMessage?.mimetype ?? message.audioMessage?.mimetype ?? message.stickerMessage?.mimetype ?? void 0;
	if (explicit) return explicit;
	if (message.audioMessage) return "audio/ogg; codecs=opus";
	if (message.imageMessage) return "image/jpeg";
	if (message.videoMessage) return "video/mp4";
	if (message.stickerMessage) return "image/webp";
}
async function downloadInboundMedia(msg, sock) {
	const message = unwrapMessage(msg.message);
	if (!message) return;
	const mimetype = resolveMediaMimetype(message);
	const fileName = message.documentMessage?.fileName ?? void 0;
	if (!message.imageMessage && !message.videoMessage && !message.documentMessage && !message.audioMessage && !message.stickerMessage) return;
	try {
		return {
			buffer: await downloadMediaMessage(msg, "buffer", {}, {
				reuploadRequest: sock.updateMediaMessage,
				logger: sock.logger
			}),
			mimetype,
			fileName
		};
	} catch (err) {
		logVerbose(`downloadMediaMessage failed: ${String(err)}`);
		return;
	}
}

//#endregion
//#region src/web/inbound/send-api.ts
function recordWhatsAppOutbound(accountId) {
	recordChannelActivity({
		channel: "whatsapp",
		accountId,
		direction: "outbound"
	});
}
function resolveOutboundMessageId(result) {
	return typeof result === "object" && result && "key" in result ? String(result.key?.id ?? "unknown") : "unknown";
}
function createWebSendApi(params) {
	return {
		sendMessage: async (to, text, mediaBuffer, mediaType, sendOptions) => {
			const jid = toWhatsappJid(to);
			let payload;
			if (mediaBuffer && mediaType) if (mediaType.startsWith("image/")) payload = {
				image: mediaBuffer,
				caption: text || void 0,
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
					caption: text || void 0,
					mimetype: mediaType,
					...gifPlayback ? { gifPlayback: true } : {}
				};
			} else payload = {
				document: mediaBuffer,
				fileName: sendOptions?.fileName?.trim() || "file",
				caption: text || void 0,
				mimetype: mediaType
			};
			else payload = { text };
			const result = await params.sock.sendMessage(jid, payload);
			recordWhatsAppOutbound(sendOptions?.accountId ?? params.defaultAccountId);
			return { messageId: resolveOutboundMessageId(result) };
		},
		sendPoll: async (to, poll) => {
			const jid = toWhatsappJid(to);
			const result = await params.sock.sendMessage(jid, { poll: {
				name: poll.question,
				values: poll.options,
				selectableCount: poll.maxSelections ?? 1
			} });
			recordWhatsAppOutbound(params.defaultAccountId);
			return { messageId: resolveOutboundMessageId(result) };
		},
		sendReaction: async (chatJid, messageId, emoji, fromMe, participant) => {
			const jid = toWhatsappJid(chatJid);
			await params.sock.sendMessage(jid, { react: {
				text: emoji,
				key: {
					remoteJid: jid,
					id: messageId,
					fromMe,
					participant: participant ? toWhatsappJid(participant) : void 0
				}
			} });
		},
		sendComposingTo: async (to) => {
			const jid = toWhatsappJid(to);
			await params.sock.sendPresenceUpdate("composing", jid);
		}
	};
}

//#endregion
//#region src/web/inbound/monitor.ts
async function monitorWebInbox(options) {
	const inboundLogger = getChildLogger({ module: "web-inbound" });
	const inboundConsoleLog = createSubsystemLogger("gateway/channels/whatsapp").child("inbound");
	const sock = await createWaSocket(false, options.verbose, { authDir: options.authDir });
	await waitForWaConnection(sock);
	const connectedAtMs = Date.now();
	let onCloseResolve = null;
	const onClose = new Promise((resolve) => {
		onCloseResolve = resolve;
	});
	const resolveClose = (reason) => {
		if (!onCloseResolve) return;
		const resolver = onCloseResolve;
		onCloseResolve = null;
		resolver(reason);
	};
	try {
		await sock.sendPresenceUpdate("available");
		if (shouldLogVerbose()) logVerbose("Sent global 'available' presence on connect");
	} catch (err) {
		logVerbose(`Failed to send 'available' presence on connect: ${String(err)}`);
	}
	const selfJid = sock.user?.id;
	const selfE164 = selfJid ? jidToE164(selfJid) : null;
	const debouncer = createInboundDebouncer({
		debounceMs: options.debounceMs ?? 0,
		buildKey: (msg) => {
			const senderKey = msg.chatType === "group" ? msg.senderJid ?? msg.senderE164 ?? msg.senderName ?? msg.from : msg.from;
			if (!senderKey) return null;
			const conversationKey = msg.chatType === "group" ? msg.chatId : msg.from;
			return `${msg.accountId}:${conversationKey}:${senderKey}`;
		},
		shouldDebounce: options.shouldDebounce,
		onFlush: async (entries) => {
			const last = entries.at(-1);
			if (!last) return;
			if (entries.length === 1) {
				await options.onMessage(last);
				return;
			}
			const mentioned = /* @__PURE__ */ new Set();
			for (const entry of entries) for (const jid of entry.mentionedJids ?? []) mentioned.add(jid);
			const combinedBody = entries.map((entry) => entry.body).filter(Boolean).join("\n");
			const combinedMessage = {
				...last,
				body: combinedBody,
				mentionedJids: mentioned.size > 0 ? Array.from(mentioned) : void 0
			};
			await options.onMessage(combinedMessage);
		},
		onError: (err) => {
			inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
			inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
		}
	});
	const groupMetaCache = /* @__PURE__ */ new Map();
	const GROUP_META_TTL_MS = 300 * 1e3;
	const lidLookup = sock.signalRepository?.lidMapping;
	const resolveInboundJid = async (jid) => resolveJidToE164(jid, {
		authDir: options.authDir,
		lidLookup
	});
	const getGroupMeta = async (jid) => {
		const cached = groupMetaCache.get(jid);
		if (cached && cached.expires > Date.now()) return cached;
		try {
			const meta = await sock.groupMetadata(jid);
			const participants = (await Promise.all(meta.participants?.map(async (p) => {
				return await resolveInboundJid(p.id) ?? p.id;
			}) ?? [])).filter(Boolean) ?? [];
			const entry = {
				subject: meta.subject,
				participants,
				expires: Date.now() + GROUP_META_TTL_MS
			};
			groupMetaCache.set(jid, entry);
			return entry;
		} catch (err) {
			logVerbose(`Failed to fetch group metadata for ${jid}: ${String(err)}`);
			return { expires: Date.now() + GROUP_META_TTL_MS };
		}
	};
	const handleMessagesUpsert = async (upsert) => {
		if (upsert.type !== "notify" && upsert.type !== "append") return;
		for (const msg of upsert.messages ?? []) {
			recordChannelActivity({
				channel: "whatsapp",
				accountId: options.accountId,
				direction: "inbound"
			});
			const id = msg.key?.id ?? void 0;
			const remoteJid = msg.key?.remoteJid;
			if (!remoteJid) continue;
			if (remoteJid.endsWith("@status") || remoteJid.endsWith("@broadcast")) continue;
			const group = isJidGroup(remoteJid) === true;
			if (id) {
				if (isRecentInboundMessage(`${options.accountId}:${remoteJid}:${id}`)) continue;
			}
			const participantJid = msg.key?.participant ?? void 0;
			const from = group ? remoteJid : await resolveInboundJid(remoteJid);
			if (!from) continue;
			const senderE164 = group ? participantJid ? await resolveInboundJid(participantJid) : null : from;
			let groupSubject;
			let groupParticipants;
			if (group) {
				const meta = await getGroupMeta(remoteJid);
				groupSubject = meta.subject;
				groupParticipants = meta.participants;
			}
			const messageTimestampMs = msg.messageTimestamp ? Number(msg.messageTimestamp) * 1e3 : void 0;
			const access = await checkInboundAccessControl({
				accountId: options.accountId,
				from,
				selfE164,
				senderE164,
				group,
				pushName: msg.pushName ?? void 0,
				isFromMe: Boolean(msg.key?.fromMe),
				messageTimestampMs,
				connectedAtMs,
				sock: { sendMessage: (jid, content) => sock.sendMessage(jid, content) },
				remoteJid
			});
			if (!access.allowed) continue;
			if (id && !access.isSelfChat && options.sendReadReceipts !== false) {
				const participant = msg.key?.participant;
				try {
					await sock.readMessages([{
						remoteJid,
						id,
						participant,
						fromMe: false
					}]);
					if (shouldLogVerbose()) logVerbose(`Marked message ${id} as read for ${remoteJid}${participant ? ` (participant ${participant})` : ""}`);
				} catch (err) {
					logVerbose(`Failed to mark message ${id} read: ${String(err)}`);
				}
			} else if (id && access.isSelfChat && shouldLogVerbose()) logVerbose(`Self-chat mode: skipping read receipt for ${id}`);
			if (upsert.type === "append") continue;
			const location = extractLocationData(msg.message ?? void 0);
			const locationText = location ? formatLocationText(location) : void 0;
			let body = extractText(msg.message ?? void 0);
			if (locationText) body = [body, locationText].filter(Boolean).join("\n").trim();
			if (!body) {
				body = extractMediaPlaceholder(msg.message ?? void 0);
				if (!body) continue;
			}
			const replyContext = describeReplyContext(msg.message);
			let mediaPath;
			let mediaType;
			let mediaFileName;
			try {
				const inboundMedia = await downloadInboundMedia(msg, sock);
				if (inboundMedia) {
					const maxBytes = (typeof options.mediaMaxMb === "number" && options.mediaMaxMb > 0 ? options.mediaMaxMb : 50) * 1024 * 1024;
					mediaPath = (await saveMediaBuffer(inboundMedia.buffer, inboundMedia.mimetype, "inbound", maxBytes, inboundMedia.fileName)).path;
					mediaType = inboundMedia.mimetype;
					mediaFileName = inboundMedia.fileName;
				}
			} catch (err) {
				logVerbose(`Inbound media download failed: ${String(err)}`);
			}
			const chatJid = remoteJid;
			const sendComposing = async () => {
				try {
					await sock.sendPresenceUpdate("composing", chatJid);
				} catch (err) {
					logVerbose(`Presence update failed: ${String(err)}`);
				}
			};
			const reply = async (text) => {
				await sock.sendMessage(chatJid, { text });
			};
			const sendMedia = async (payload) => {
				await sock.sendMessage(chatJid, payload);
			};
			const timestamp = messageTimestampMs;
			const mentionedJids = extractMentionedJids(msg.message);
			const senderName = msg.pushName ?? void 0;
			inboundLogger.info({
				from,
				to: selfE164 ?? "me",
				body,
				mediaPath,
				mediaType,
				mediaFileName,
				timestamp
			}, "inbound message");
			const inboundMessage = {
				id,
				from,
				conversationId: from,
				to: selfE164 ?? "me",
				accountId: access.resolvedAccountId,
				body,
				pushName: senderName,
				timestamp,
				chatType: group ? "group" : "direct",
				chatId: remoteJid,
				senderJid: participantJid,
				senderE164: senderE164 ?? void 0,
				senderName,
				replyToId: replyContext?.id,
				replyToBody: replyContext?.body,
				replyToSender: replyContext?.sender,
				replyToSenderJid: replyContext?.senderJid,
				replyToSenderE164: replyContext?.senderE164,
				groupSubject,
				groupParticipants,
				mentionedJids: mentionedJids ?? void 0,
				selfJid,
				selfE164,
				location: location ?? void 0,
				sendComposing,
				reply,
				sendMedia,
				mediaPath,
				mediaType,
				mediaFileName
			};
			try {
				Promise.resolve(debouncer.enqueue(inboundMessage)).catch((err) => {
					inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
					inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
				});
			} catch (err) {
				inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
				inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
			}
		}
	};
	sock.ev.on("messages.upsert", handleMessagesUpsert);
	const handleConnectionUpdate = (update) => {
		try {
			if (update.connection === "close") {
				const status = getStatusCode(update.lastDisconnect?.error);
				resolveClose({
					status,
					isLoggedOut: status === DisconnectReason.loggedOut,
					error: update.lastDisconnect?.error
				});
			}
		} catch (err) {
			inboundLogger.error({ error: String(err) }, "connection.update handler error");
			resolveClose({
				status: void 0,
				isLoggedOut: false,
				error: err
			});
		}
	};
	sock.ev.on("connection.update", handleConnectionUpdate);
	return {
		close: async () => {
			try {
				const ev = sock.ev;
				const messagesUpsertHandler = handleMessagesUpsert;
				const connectionUpdateHandler = handleConnectionUpdate;
				if (typeof ev.off === "function") {
					ev.off("messages.upsert", messagesUpsertHandler);
					ev.off("connection.update", connectionUpdateHandler);
				} else if (typeof ev.removeListener === "function") {
					ev.removeListener("messages.upsert", messagesUpsertHandler);
					ev.removeListener("connection.update", connectionUpdateHandler);
				}
				sock.ws?.close();
			} catch (err) {
				logVerbose(`Socket close failed: ${String(err)}`);
			}
		},
		onClose,
		signalClose: (reason) => {
			resolveClose(reason ?? {
				status: void 0,
				isLoggedOut: false,
				error: "closed"
			});
		},
		...createWebSendApi({
			sock: {
				sendMessage: (jid, content) => sock.sendMessage(jid, content),
				sendPresenceUpdate: (presence, jid) => sock.sendPresenceUpdate(presence, jid)
			},
			defaultAccountId: options.accountId
		})
	};
}

//#endregion
//#region src/web/auto-reply/mentions.ts
function buildMentionConfig(cfg, agentId) {
	return {
		mentionRegexes: buildMentionRegexes(cfg, agentId),
		allowFrom: cfg.channels?.whatsapp?.allowFrom
	};
}
function resolveMentionTargets(msg, authDir) {
	const jidOptions = authDir ? { authDir } : void 0;
	return {
		normalizedMentions: msg.mentionedJids?.length ? msg.mentionedJids.map((jid) => jidToE164(jid, jidOptions) ?? jid).filter(Boolean) : [],
		selfE164: msg.selfE164 ?? (msg.selfJid ? jidToE164(msg.selfJid, jidOptions) : null),
		selfJid: msg.selfJid ? msg.selfJid.replace(/:\\d+/, "") : null
	};
}
function isBotMentionedFromTargets(msg, mentionCfg, targets) {
	const clean = (text) => normalizeMentionText(text);
	const isSelfChat = isSelfChatMode(targets.selfE164, mentionCfg.allowFrom);
	const hasMentions = (msg.mentionedJids?.length ?? 0) > 0;
	if (hasMentions && !isSelfChat) {
		if (targets.selfE164 && targets.normalizedMentions.includes(targets.selfE164)) return true;
		if (targets.selfJid) {
			if (targets.normalizedMentions.includes(targets.selfJid)) return true;
		}
		return false;
	} else if (hasMentions && isSelfChat) {}
	const bodyClean = clean(msg.body);
	if (mentionCfg.mentionRegexes.some((re) => re.test(bodyClean))) return true;
	if (targets.selfE164) {
		const selfDigits = targets.selfE164.replace(/\D/g, "");
		if (selfDigits) {
			if (bodyClean.replace(/[^\d]/g, "").includes(selfDigits)) return true;
			const bodyNoSpace = msg.body.replace(/[\s-]/g, "");
			if (new RegExp(`\\+?${selfDigits}`, "i").test(bodyNoSpace)) return true;
		}
	}
	return false;
}
function debugMention(msg, mentionCfg, authDir) {
	const mentionTargets = resolveMentionTargets(msg, authDir);
	return {
		wasMentioned: isBotMentionedFromTargets(msg, mentionCfg, mentionTargets),
		details: {
			from: msg.from,
			body: msg.body,
			bodyClean: normalizeMentionText(msg.body),
			mentionedJids: msg.mentionedJids ?? null,
			normalizedMentionedJids: mentionTargets.normalizedMentions.length ? mentionTargets.normalizedMentions : null,
			selfJid: msg.selfJid ?? null,
			selfJidBare: mentionTargets.selfJid,
			selfE164: msg.selfE164 ?? null,
			resolvedSelfE164: mentionTargets.selfE164
		}
	};
}
function resolveOwnerList(mentionCfg, selfE164) {
	const allowFrom = mentionCfg.allowFrom;
	return (Array.isArray(allowFrom) && allowFrom.length > 0 ? allowFrom : selfE164 ? [selfE164] : []).filter((entry) => Boolean(entry && entry !== "*")).map((entry) => normalizeE164(entry)).filter((entry) => Boolean(entry));
}

//#endregion
//#region src/web/auto-reply/monitor/echo.ts
function createEchoTracker(params) {
	const recentlySent = /* @__PURE__ */ new Set();
	const maxItems = Math.max(1, params.maxItems ?? 100);
	const buildCombinedKey = (p) => `combined:${p.sessionKey}:${p.combinedBody}`;
	const trim = () => {
		while (recentlySent.size > maxItems) {
			const firstKey = recentlySent.values().next().value;
			if (!firstKey) break;
			recentlySent.delete(firstKey);
		}
	};
	const rememberText = (text, opts) => {
		if (!text) return;
		recentlySent.add(text);
		if (opts.combinedBody && opts.combinedBodySessionKey) recentlySent.add(buildCombinedKey({
			sessionKey: opts.combinedBodySessionKey,
			combinedBody: opts.combinedBody
		}));
		if (opts.logVerboseMessage) params.logVerbose?.(`Added to echo detection set (size now: ${recentlySent.size}): ${text.substring(0, 50)}...`);
		trim();
	};
	return {
		rememberText,
		has: (key) => recentlySent.has(key),
		forget: (key) => {
			recentlySent.delete(key);
		},
		buildCombinedKey
	};
}

//#endregion
//#region src/web/auto-reply/monitor/broadcast.ts
async function maybeBroadcastMessage(params) {
	const broadcastAgents = params.cfg.broadcast?.[params.peerId];
	if (!broadcastAgents || !Array.isArray(broadcastAgents)) return false;
	if (broadcastAgents.length === 0) return false;
	const strategy = params.cfg.broadcast?.strategy || "parallel";
	whatsappInboundLog.info(`Broadcasting message to ${broadcastAgents.length} agents (${strategy})`);
	const agentIds = params.cfg.agents?.list?.map((agent) => normalizeAgentId(agent.id));
	const hasKnownAgents = (agentIds?.length ?? 0) > 0;
	const groupHistorySnapshot = params.msg.chatType === "group" ? params.groupHistories.get(params.groupHistoryKey) ?? [] : void 0;
	const processForAgent = async (agentId) => {
		const normalizedAgentId = normalizeAgentId(agentId);
		if (hasKnownAgents && !agentIds?.includes(normalizedAgentId)) {
			whatsappInboundLog.warn(`Broadcast agent ${agentId} not found in agents.list; skipping`);
			return false;
		}
		const agentRoute = {
			...params.route,
			agentId: normalizedAgentId,
			sessionKey: buildAgentSessionKey({
				agentId: normalizedAgentId,
				channel: "whatsapp",
				accountId: params.route.accountId,
				peer: {
					kind: params.msg.chatType === "group" ? "group" : "direct",
					id: params.peerId
				},
				dmScope: params.cfg.session?.dmScope,
				identityLinks: params.cfg.session?.identityLinks
			}),
			mainSessionKey: buildAgentMainSessionKey({
				agentId: normalizedAgentId,
				mainKey: DEFAULT_MAIN_KEY
			})
		};
		try {
			return await params.processMessage(params.msg, agentRoute, params.groupHistoryKey, {
				groupHistory: groupHistorySnapshot,
				suppressGroupHistoryClear: true
			});
		} catch (err) {
			whatsappInboundLog.error(`Broadcast agent ${agentId} failed: ${formatError(err)}`);
			return false;
		}
	};
	if (strategy === "sequential") for (const agentId of broadcastAgents) await processForAgent(agentId);
	else await Promise.allSettled(broadcastAgents.map(processForAgent));
	if (params.msg.chatType === "group") params.groupHistories.set(params.groupHistoryKey, []);
	return true;
}

//#endregion
//#region src/web/auto-reply/monitor/commands.ts
function stripMentionsForCommand(text, mentionRegexes, selfE164) {
	let result = text;
	for (const re of mentionRegexes) result = result.replace(re, " ");
	if (selfE164) {
		const digits = selfE164.replace(/\D/g, "");
		if (digits) {
			const pattern = new RegExp(`\\+?${digits}`, "g");
			result = result.replace(pattern, " ");
		}
	}
	return result.replace(/\s+/g, " ").trim();
}

//#endregion
//#region src/web/auto-reply/monitor/group-activation.ts
function resolveGroupPolicyFor(cfg, conversationId) {
	const groupId = resolveGroupSessionKey({
		From: conversationId,
		ChatType: "group",
		Provider: "whatsapp"
	})?.id;
	const whatsappCfg = cfg.channels?.whatsapp;
	const hasGroupAllowFrom = Boolean(whatsappCfg?.groupAllowFrom?.length || whatsappCfg?.allowFrom?.length);
	return resolveChannelGroupPolicy({
		cfg,
		channel: "whatsapp",
		groupId: groupId ?? conversationId,
		hasGroupAllowFrom
	});
}
function resolveGroupRequireMentionFor(cfg, conversationId) {
	const groupId = resolveGroupSessionKey({
		From: conversationId,
		ChatType: "group",
		Provider: "whatsapp"
	})?.id;
	return resolveChannelGroupRequireMention({
		cfg,
		channel: "whatsapp",
		groupId: groupId ?? conversationId
	});
}
function resolveGroupActivationFor(params) {
	const entry = loadSessionStore(resolveStorePath(params.cfg.session?.store, { agentId: params.agentId }))[params.sessionKey];
	const defaultActivation = !resolveGroupRequireMentionFor(params.cfg, params.conversationId) ? "always" : "mention";
	return normalizeGroupActivation(entry?.groupActivation) ?? defaultActivation;
}

//#endregion
//#region src/web/auto-reply/monitor/group-members.ts
function appendNormalizedUnique(entries, seen, ordered) {
	for (const entry of entries) {
		const normalized = normalizeE164(entry) ?? entry;
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		ordered.push(normalized);
	}
}
function noteGroupMember(groupMemberNames, conversationId, e164, name) {
	if (!e164 || !name) return;
	const key = normalizeE164(e164) ?? e164;
	if (!key) return;
	let roster = groupMemberNames.get(conversationId);
	if (!roster) {
		roster = /* @__PURE__ */ new Map();
		groupMemberNames.set(conversationId, roster);
	}
	roster.set(key, name);
}
function formatGroupMembers(params) {
	const { participants, roster, fallbackE164 } = params;
	const seen = /* @__PURE__ */ new Set();
	const ordered = [];
	if (participants?.length) appendNormalizedUnique(participants, seen, ordered);
	if (roster) appendNormalizedUnique(roster.keys(), seen, ordered);
	if (ordered.length === 0 && fallbackE164) {
		const normalized = normalizeE164(fallbackE164) ?? fallbackE164;
		if (normalized) ordered.push(normalized);
	}
	if (ordered.length === 0) return;
	return ordered.map((entry) => {
		const name = roster?.get(entry);
		return name ? `${name} (${entry})` : entry;
	}).join(", ");
}

//#endregion
//#region src/web/auto-reply/monitor/group-gating.ts
function isOwnerSender(baseMentionConfig, msg) {
	const sender = normalizeE164(msg.senderE164 ?? "");
	if (!sender) return false;
	return resolveOwnerList(baseMentionConfig, msg.selfE164 ?? void 0).includes(sender);
}
function recordPendingGroupHistoryEntry(params) {
	const sender = params.msg.senderName && params.msg.senderE164 ? `${params.msg.senderName} (${params.msg.senderE164})` : params.msg.senderName ?? params.msg.senderE164 ?? "Unknown";
	recordPendingHistoryEntryIfEnabled({
		historyMap: params.groupHistories,
		historyKey: params.groupHistoryKey,
		limit: params.groupHistoryLimit,
		entry: {
			sender,
			body: params.msg.body,
			timestamp: params.msg.timestamp,
			id: params.msg.id,
			senderJid: params.msg.senderJid
		}
	});
}
function skipGroupMessageAndStoreHistory(params, verboseMessage) {
	params.logVerbose(verboseMessage);
	recordPendingGroupHistoryEntry({
		msg: params.msg,
		groupHistories: params.groupHistories,
		groupHistoryKey: params.groupHistoryKey,
		groupHistoryLimit: params.groupHistoryLimit
	});
	return { shouldProcess: false };
}
function applyGroupGating(params) {
	const groupPolicy = resolveGroupPolicyFor(params.cfg, params.conversationId);
	if (groupPolicy.allowlistEnabled && !groupPolicy.allowed) {
		params.logVerbose(`Skipping group message ${params.conversationId} (not in allowlist)`);
		return { shouldProcess: false };
	}
	noteGroupMember(params.groupMemberNames, params.groupHistoryKey, params.msg.senderE164, params.msg.senderName);
	const mentionConfig = buildMentionConfig(params.cfg, params.agentId);
	const commandBody = stripMentionsForCommand(params.msg.body, mentionConfig.mentionRegexes, params.msg.selfE164);
	const activationCommand = parseActivationCommand(commandBody);
	const owner = isOwnerSender(params.baseMentionConfig, params.msg);
	const shouldBypassMention = owner && hasControlCommand(commandBody, params.cfg);
	if (activationCommand.hasCommand && !owner) return skipGroupMessageAndStoreHistory(params, `Ignoring /activation from non-owner in group ${params.conversationId}`);
	const mentionDebug = debugMention(params.msg, mentionConfig, params.authDir);
	params.replyLogger.debug({
		conversationId: params.conversationId,
		wasMentioned: mentionDebug.wasMentioned,
		...mentionDebug.details
	}, "group mention debug");
	const wasMentioned = mentionDebug.wasMentioned;
	const requireMention = resolveGroupActivationFor({
		cfg: params.cfg,
		agentId: params.agentId,
		sessionKey: params.sessionKey,
		conversationId: params.conversationId
	}) !== "always";
	const selfJid = params.msg.selfJid?.replace(/:\\d+/, "");
	const replySenderJid = params.msg.replyToSenderJid?.replace(/:\\d+/, "");
	const selfE164 = params.msg.selfE164 ? normalizeE164(params.msg.selfE164) : null;
	const replySenderE164 = params.msg.replyToSenderE164 ? normalizeE164(params.msg.replyToSenderE164) : null;
	const mentionGate = resolveMentionGating({
		requireMention,
		canDetectMention: true,
		wasMentioned,
		implicitMention: Boolean(selfJid && replySenderJid && selfJid === replySenderJid || selfE164 && replySenderE164 && selfE164 === replySenderE164),
		shouldBypassMention
	});
	params.msg.wasMentioned = mentionGate.effectiveWasMentioned;
	if (!shouldBypassMention && requireMention && mentionGate.shouldSkip) return skipGroupMessageAndStoreHistory(params, `Group message stored for context (no mention detected) in ${params.conversationId}: ${params.msg.body}`);
	return { shouldProcess: true };
}

//#endregion
//#region src/web/auto-reply/monitor/last-route.ts
function trackBackgroundTask(backgroundTasks, task) {
	backgroundTasks.add(task);
	task.finally(() => {
		backgroundTasks.delete(task);
	});
}
function updateLastRouteInBackground(params) {
	const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.storeAgentId });
	const task = updateLastRoute({
		storePath,
		sessionKey: params.sessionKey,
		deliveryContext: {
			channel: params.channel,
			to: params.to,
			accountId: params.accountId
		},
		ctx: params.ctx
	}).catch((err) => {
		params.warn({
			error: formatError(err),
			storePath,
			sessionKey: params.sessionKey,
			to: params.to
		}, "failed updating last route");
	});
	trackBackgroundTask(params.backgroundTasks, task);
}

//#endregion
//#region src/web/auto-reply/monitor/peer.ts
function resolvePeerId(msg) {
	if (msg.chatType === "group") return msg.conversationId ?? msg.from;
	if (msg.senderE164) return normalizeE164(msg.senderE164) ?? msg.senderE164;
	if (msg.from.includes("@")) return jidToE164(msg.from) ?? msg.from;
	return normalizeE164(msg.from) ?? msg.from;
}

//#endregion
//#region src/web/auto-reply/util.ts
function elide(text, limit = 400) {
	if (!text) return text;
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}… (truncated ${text.length - limit} chars)`;
}
function isLikelyWhatsAppCryptoError(reason) {
	const formatReason = (value) => {
		if (value == null) return "";
		if (typeof value === "string") return value;
		if (value instanceof Error) return `${value.message}\n${value.stack ?? ""}`;
		if (typeof value === "object") try {
			return JSON.stringify(value);
		} catch {
			return Object.prototype.toString.call(value);
		}
		if (typeof value === "number") return String(value);
		if (typeof value === "boolean") return String(value);
		if (typeof value === "bigint") return String(value);
		if (typeof value === "symbol") return value.description ?? value.toString();
		if (typeof value === "function") return value.name ? `[function ${value.name}]` : "[function]";
		return Object.prototype.toString.call(value);
	};
	const haystack = (reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : formatReason(reason)).toLowerCase();
	if (!(haystack.includes("unsupported state or unable to authenticate data") || haystack.includes("bad mac"))) return false;
	return haystack.includes("@whiskeysockets/baileys") || haystack.includes("baileys") || haystack.includes("noise-handler") || haystack.includes("aesdecryptgcm");
}

//#endregion
//#region src/web/auto-reply/deliver-reply.ts
const REASONING_PREFIX = "reasoning:";
function shouldSuppressReasoningReply(payload) {
	if (payload.isReasoning === true) return true;
	const text = payload.text;
	if (typeof text !== "string") return false;
	return text.trimStart().toLowerCase().startsWith(REASONING_PREFIX);
}
async function deliverWebReply(params) {
	const { replyResult, msg, maxMediaBytes, textLimit, replyLogger, connectionId, skipLog } = params;
	const replyStarted = Date.now();
	if (shouldSuppressReasoningReply(replyResult)) {
		whatsappOutboundLog.debug(`Suppressed reasoning payload to ${msg.from}`);
		return;
	}
	const tableMode = params.tableMode ?? "code";
	const chunkMode = params.chunkMode ?? "length";
	const textChunks = chunkMarkdownTextWithMode(markdownToWhatsApp(convertMarkdownTables(replyResult.text || "", tableMode)), textLimit, chunkMode);
	const mediaList = replyResult.mediaUrls?.length ? replyResult.mediaUrls : replyResult.mediaUrl ? [replyResult.mediaUrl] : [];
	const sendWithRetry = async (fn, label, maxAttempts = 3) => {
		let lastErr;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) try {
			return await fn();
		} catch (err) {
			lastErr = err;
			const errText = formatError(err);
			const isLast = attempt === maxAttempts;
			if (!/closed|reset|timed\s*out|disconnect/i.test(errText) || isLast) throw err;
			const backoffMs = 500 * attempt;
			logVerbose(`Retrying ${label} to ${msg.from} after failure (${attempt}/${maxAttempts - 1}) in ${backoffMs}ms: ${errText}`);
			await sleep(backoffMs);
		}
		throw lastErr;
	};
	if (mediaList.length === 0 && textChunks.length) {
		const totalChunks = textChunks.length;
		for (const [index, chunk] of textChunks.entries()) {
			const chunkStarted = Date.now();
			await sendWithRetry(() => msg.reply(chunk), "text");
			if (!skipLog) {
				const durationMs = Date.now() - chunkStarted;
				whatsappOutboundLog.debug(`Sent chunk ${index + 1}/${totalChunks} to ${msg.from} (${durationMs.toFixed(0)}ms)`);
			}
		}
		replyLogger.info({
			correlationId: msg.id ?? newConnectionId(),
			connectionId: connectionId ?? null,
			to: msg.from,
			from: msg.to,
			text: elide(replyResult.text, 240),
			mediaUrl: null,
			mediaSizeBytes: null,
			mediaKind: null,
			durationMs: Date.now() - replyStarted
		}, "auto-reply sent (text)");
		return;
	}
	const remainingText = [...textChunks];
	for (const [index, mediaUrl] of mediaList.entries()) {
		const caption = index === 0 ? remainingText.shift() || void 0 : void 0;
		try {
			const media = await loadWebMedia(mediaUrl, {
				maxBytes: maxMediaBytes,
				localRoots: params.mediaLocalRoots
			});
			if (shouldLogVerbose()) {
				logVerbose(`Web auto-reply media size: ${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB`);
				logVerbose(`Web auto-reply media source: ${mediaUrl} (kind ${media.kind})`);
			}
			if (media.kind === "image") await sendWithRetry(() => msg.sendMedia({
				image: media.buffer,
				caption,
				mimetype: media.contentType
			}), "media:image");
			else if (media.kind === "audio") await sendWithRetry(() => msg.sendMedia({
				audio: media.buffer,
				ptt: true,
				mimetype: media.contentType,
				caption
			}), "media:audio");
			else if (media.kind === "video") await sendWithRetry(() => msg.sendMedia({
				video: media.buffer,
				caption,
				mimetype: media.contentType
			}), "media:video");
			else {
				const fileName = media.fileName ?? mediaUrl.split("/").pop() ?? "file";
				const mimetype = media.contentType ?? "application/octet-stream";
				await sendWithRetry(() => msg.sendMedia({
					document: media.buffer,
					fileName,
					caption,
					mimetype
				}), "media:document");
			}
			whatsappOutboundLog.info(`Sent media reply to ${msg.from} (${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB)`);
			replyLogger.info({
				correlationId: msg.id ?? newConnectionId(),
				connectionId: connectionId ?? null,
				to: msg.from,
				from: msg.to,
				text: caption ?? null,
				mediaUrl,
				mediaSizeBytes: media.buffer.length,
				mediaKind: media.kind,
				durationMs: Date.now() - replyStarted
			}, "auto-reply sent (media)");
		} catch (err) {
			whatsappOutboundLog.error(`Failed sending web media to ${msg.from}: ${formatError(err)}`);
			replyLogger.warn({
				err,
				mediaUrl
			}, "failed to send web media reply");
			if (index === 0) {
				const warning = err instanceof Error ? `⚠️ Media failed: ${err.message}` : "⚠️ Media failed.";
				const fallbackText = [remainingText.shift() ?? caption ?? "", warning].filter(Boolean).join("\n");
				if (fallbackText) {
					whatsappOutboundLog.warn(`Media skipped; sent text-only to ${msg.from}`);
					await msg.reply(fallbackText);
				}
			}
		}
	}
	for (const chunk of remainingText) await msg.reply(chunk);
}

//#endregion
//#region src/web/auto-reply/monitor/ack-reaction.ts
function maybeSendAckReaction(params) {
	if (!params.msg.id) return;
	const ackConfig = params.cfg.channels?.whatsapp?.ackReaction;
	const emoji = (ackConfig?.emoji ?? "").trim();
	const directEnabled = ackConfig?.direct ?? true;
	const groupMode = ackConfig?.group ?? "mentions";
	const conversationIdForCheck = params.msg.conversationId ?? params.msg.from;
	const activation = params.msg.chatType === "group" ? resolveGroupActivationFor({
		cfg: params.cfg,
		agentId: params.agentId,
		sessionKey: params.sessionKey,
		conversationId: conversationIdForCheck
	}) : null;
	const shouldSendReaction = () => shouldAckReactionForWhatsApp({
		emoji,
		isDirect: params.msg.chatType === "direct",
		isGroup: params.msg.chatType === "group",
		directEnabled,
		groupMode,
		wasMentioned: params.msg.wasMentioned === true,
		groupActivated: activation === "always"
	});
	if (!shouldSendReaction()) return;
	params.info({
		chatId: params.msg.chatId,
		messageId: params.msg.id,
		emoji
	}, "sending ack reaction");
	sendReactionWhatsApp(params.msg.chatId, params.msg.id, emoji, {
		verbose: params.verbose,
		fromMe: false,
		participant: params.msg.senderJid,
		accountId: params.accountId
	}).catch((err) => {
		params.warn({
			error: formatError(err),
			chatId: params.msg.chatId,
			messageId: params.msg.id
		}, "failed to send ack reaction");
		logVerbose(`WhatsApp ack reaction failed for chat ${params.msg.chatId}: ${formatError(err)}`);
	});
}

//#endregion
//#region src/web/auto-reply/monitor/message-line.ts
function formatReplyContext(msg) {
	if (!msg.replyToBody) return null;
	return `[Replying to ${msg.replyToSender ?? "unknown sender"}${msg.replyToId ? ` id:${msg.replyToId}` : ""}]\n${msg.replyToBody}\n[/Replying]`;
}
function buildInboundLine(params) {
	const { cfg, msg, agentId, previousTimestamp, envelope } = params;
	const messagePrefix = resolveMessagePrefix(cfg, agentId, {
		configured: cfg.channels?.whatsapp?.messagePrefix,
		hasAllowFrom: (cfg.channels?.whatsapp?.allowFrom?.length ?? 0) > 0
	});
	const prefixStr = messagePrefix ? `${messagePrefix} ` : "";
	const replyContext = formatReplyContext(msg);
	const baseLine = `${prefixStr}${msg.body}${replyContext ? `\n\n${replyContext}` : ""}`;
	return formatInboundEnvelope({
		channel: "WhatsApp",
		from: msg.chatType === "group" ? msg.from : msg.from?.replace(/^whatsapp:/, ""),
		timestamp: msg.timestamp,
		body: baseLine,
		chatType: msg.chatType,
		sender: {
			name: msg.senderName,
			e164: msg.senderE164,
			id: msg.senderJid
		},
		previousTimestamp,
		envelope
	});
}

//#endregion
//#region src/web/auto-reply/monitor/process-message.ts
async function resolveWhatsAppCommandAuthorized(params) {
	const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
	if (!useAccessGroups) return true;
	const isGroup = params.msg.chatType === "group";
	const senderE164 = normalizeE164(isGroup ? params.msg.senderE164 ?? "" : params.msg.senderE164 ?? params.msg.from ?? "");
	if (!senderE164) return false;
	const account = resolveWhatsAppAccount({
		cfg: params.cfg,
		accountId: params.msg.accountId
	});
	const dmPolicy = account.dmPolicy ?? "pairing";
	const groupPolicy = account.groupPolicy ?? "allowlist";
	const configuredAllowFrom = account.allowFrom ?? [];
	const configuredGroupAllowFrom = account.groupAllowFrom ?? (configuredAllowFrom.length > 0 ? configuredAllowFrom : void 0);
	const storeAllowFrom = isGroup ? [] : await readStoreAllowFromForDmPolicy({
		provider: "whatsapp",
		accountId: params.msg.accountId,
		dmPolicy
	});
	return resolveDmGroupAccessWithCommandGate({
		isGroup,
		dmPolicy,
		groupPolicy,
		allowFrom: configuredAllowFrom.length > 0 ? configuredAllowFrom : params.msg.selfE164 ? [params.msg.selfE164] : [],
		groupAllowFrom: configuredGroupAllowFrom,
		storeAllowFrom,
		isSenderAllowed: (allowEntries) => {
			if (allowEntries.includes("*")) return true;
			return allowEntries.map((entry) => normalizeE164(String(entry))).filter((entry) => Boolean(entry)).includes(senderE164);
		},
		command: {
			useAccessGroups,
			allowTextCommands: true,
			hasControlCommand: true
		}
	}).commandAuthorized;
}
async function processMessage(params) {
	const conversationId = params.msg.conversationId ?? params.msg.from;
	const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.route.agentId });
	const envelopeOptions = resolveEnvelopeFormatOptions(params.cfg);
	const previousTimestamp = readSessionUpdatedAt({
		storePath,
		sessionKey: params.route.sessionKey
	});
	let combinedBody = buildInboundLine({
		cfg: params.cfg,
		msg: params.msg,
		agentId: params.route.agentId,
		previousTimestamp,
		envelope: envelopeOptions
	});
	let shouldClearGroupHistory = false;
	if (params.msg.chatType === "group") {
		const history = params.groupHistory ?? params.groupHistories.get(params.groupHistoryKey) ?? [];
		if (history.length > 0) combinedBody = buildHistoryContextFromEntries({
			entries: history.map((m) => ({
				sender: m.sender,
				body: m.body,
				timestamp: m.timestamp
			})),
			currentMessage: combinedBody,
			excludeLast: false,
			formatEntry: (entry) => {
				return formatInboundEnvelope({
					channel: "WhatsApp",
					from: conversationId,
					timestamp: entry.timestamp,
					body: entry.body,
					chatType: "group",
					senderLabel: entry.sender,
					envelope: envelopeOptions
				});
			}
		});
		shouldClearGroupHistory = !(params.suppressGroupHistoryClear ?? false);
	}
	const combinedEchoKey = params.buildCombinedEchoKey({
		sessionKey: params.route.sessionKey,
		combinedBody
	});
	if (params.echoHas(combinedEchoKey)) {
		logVerbose("Skipping auto-reply: detected echo for combined message");
		params.echoForget(combinedEchoKey);
		return false;
	}
	maybeSendAckReaction({
		cfg: params.cfg,
		msg: params.msg,
		agentId: params.route.agentId,
		sessionKey: params.route.sessionKey,
		conversationId,
		verbose: params.verbose,
		accountId: params.route.accountId,
		info: params.replyLogger.info.bind(params.replyLogger),
		warn: params.replyLogger.warn.bind(params.replyLogger)
	});
	const correlationId = params.msg.id ?? newConnectionId();
	params.replyLogger.info({
		connectionId: params.connectionId,
		correlationId,
		from: params.msg.chatType === "group" ? conversationId : params.msg.from,
		to: params.msg.to,
		body: elide(combinedBody, 240),
		mediaType: params.msg.mediaType ?? null,
		mediaPath: params.msg.mediaPath ?? null
	}, "inbound web message");
	const fromDisplay = params.msg.chatType === "group" ? conversationId : params.msg.from;
	const kindLabel = params.msg.mediaType ? `, ${params.msg.mediaType}` : "";
	whatsappInboundLog.info(`Inbound message ${fromDisplay} -> ${params.msg.to} (${params.msg.chatType}${kindLabel}, ${combinedBody.length} chars)`);
	if (shouldLogVerbose()) whatsappInboundLog.debug(`Inbound body: ${elide(combinedBody, 400)}`);
	const dmRouteTarget = params.msg.chatType !== "group" ? (() => {
		if (params.msg.senderE164) return normalizeE164(params.msg.senderE164);
		if (params.msg.from.includes("@")) return jidToE164(params.msg.from);
		return normalizeE164(params.msg.from);
	})() : void 0;
	const textLimit = params.maxMediaTextChunkLimit ?? resolveTextChunkLimit(params.cfg, "whatsapp");
	const chunkMode = resolveChunkMode(params.cfg, "whatsapp", params.route.accountId);
	const tableMode = resolveMarkdownTableMode({
		cfg: params.cfg,
		channel: "whatsapp",
		accountId: params.route.accountId
	});
	const mediaLocalRoots = getAgentScopedMediaLocalRoots(params.cfg, params.route.agentId);
	let didLogHeartbeatStrip = false;
	let didSendReply = false;
	const commandAuthorized = shouldComputeCommandAuthorized(params.msg.body, params.cfg) ? await resolveWhatsAppCommandAuthorized({
		cfg: params.cfg,
		msg: params.msg
	}) : void 0;
	const configuredResponsePrefix = params.cfg.messages?.responsePrefix;
	const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
		cfg: params.cfg,
		agentId: params.route.agentId,
		channel: "whatsapp",
		accountId: params.route.accountId
	});
	const isSelfChat = params.msg.chatType !== "group" && Boolean(params.msg.selfE164) && normalizeE164(params.msg.from) === normalizeE164(params.msg.selfE164 ?? "");
	const responsePrefix = prefixOptions.responsePrefix ?? (configuredResponsePrefix === void 0 && isSelfChat ? resolveIdentityNamePrefix(params.cfg, params.route.agentId) ?? "[openclaw]" : void 0);
	const inboundHistory = params.msg.chatType === "group" ? (params.groupHistory ?? params.groupHistories.get(params.groupHistoryKey) ?? []).map((entry) => ({
		sender: entry.sender,
		body: entry.body,
		timestamp: entry.timestamp
	})) : void 0;
	const ctxPayload = finalizeInboundContext({
		Body: combinedBody,
		BodyForAgent: params.msg.body,
		InboundHistory: inboundHistory,
		RawBody: params.msg.body,
		CommandBody: params.msg.body,
		From: params.msg.from,
		To: params.msg.to,
		SessionKey: params.route.sessionKey,
		AccountId: params.route.accountId,
		MessageSid: params.msg.id,
		ReplyToId: params.msg.replyToId,
		ReplyToBody: params.msg.replyToBody,
		ReplyToSender: params.msg.replyToSender,
		MediaPath: params.msg.mediaPath,
		MediaUrl: params.msg.mediaUrl,
		MediaType: params.msg.mediaType,
		ChatType: params.msg.chatType,
		ConversationLabel: params.msg.chatType === "group" ? conversationId : params.msg.from,
		GroupSubject: params.msg.groupSubject,
		GroupMembers: formatGroupMembers({
			participants: params.msg.groupParticipants,
			roster: params.groupMemberNames.get(params.groupHistoryKey),
			fallbackE164: params.msg.senderE164
		}),
		SenderName: params.msg.senderName,
		SenderId: params.msg.senderJid?.trim() || params.msg.senderE164,
		SenderE164: params.msg.senderE164,
		CommandAuthorized: commandAuthorized,
		WasMentioned: params.msg.wasMentioned,
		...params.msg.location ? toLocationContext(params.msg.location) : {},
		Provider: "whatsapp",
		Surface: "whatsapp",
		OriginatingChannel: "whatsapp",
		OriginatingTo: params.msg.from
	});
	if (dmRouteTarget && params.route.sessionKey === params.route.mainSessionKey) updateLastRouteInBackground({
		cfg: params.cfg,
		backgroundTasks: params.backgroundTasks,
		storeAgentId: params.route.agentId,
		sessionKey: params.route.mainSessionKey,
		channel: "whatsapp",
		to: dmRouteTarget,
		accountId: params.route.accountId,
		ctx: ctxPayload,
		warn: params.replyLogger.warn.bind(params.replyLogger)
	});
	const metaTask = recordSessionMetaFromInbound({
		storePath,
		sessionKey: params.route.sessionKey,
		ctx: ctxPayload
	}).catch((err) => {
		params.replyLogger.warn({
			error: formatError(err),
			storePath,
			sessionKey: params.route.sessionKey
		}, "failed updating session meta");
	});
	trackBackgroundTask(params.backgroundTasks, metaTask);
	const { queuedFinal } = await dispatchReplyWithBufferedBlockDispatcher({
		ctx: ctxPayload,
		cfg: params.cfg,
		replyResolver: params.replyResolver,
		dispatcherOptions: {
			...prefixOptions,
			responsePrefix,
			onHeartbeatStrip: () => {
				if (!didLogHeartbeatStrip) {
					didLogHeartbeatStrip = true;
					logVerbose("Stripped stray HEARTBEAT_OK token from web reply");
				}
			},
			deliver: async (payload, info) => {
				if (info.kind !== "final") return;
				await deliverWebReply({
					replyResult: payload,
					msg: params.msg,
					mediaLocalRoots,
					maxMediaBytes: params.maxMediaBytes,
					textLimit,
					chunkMode,
					replyLogger: params.replyLogger,
					connectionId: params.connectionId,
					skipLog: false,
					tableMode
				});
				didSendReply = true;
				const shouldLog = payload.text ? true : void 0;
				params.rememberSentText(payload.text, {
					combinedBody,
					combinedBodySessionKey: params.route.sessionKey,
					logVerboseMessage: shouldLog
				});
				const fromDisplay = params.msg.chatType === "group" ? conversationId : params.msg.from ?? "unknown";
				const hasMedia = Boolean(payload.mediaUrl || payload.mediaUrls?.length);
				whatsappOutboundLog.info(`Auto-replied to ${fromDisplay}${hasMedia ? " (media)" : ""}`);
				if (shouldLogVerbose()) {
					const preview = payload.text != null ? elide(payload.text, 400) : "<media>";
					whatsappOutboundLog.debug(`Reply body: ${preview}${hasMedia ? " (media)" : ""}`);
				}
			},
			onError: (err, info) => {
				const label = info.kind === "tool" ? "tool update" : info.kind === "block" ? "block update" : "auto-reply";
				whatsappOutboundLog.error(`Failed sending web ${label} to ${params.msg.from ?? conversationId}: ${formatError(err)}`);
			},
			onReplyStart: params.msg.sendComposing
		},
		replyOptions: {
			disableBlockStreaming: true,
			onModelSelected
		}
	});
	if (!queuedFinal) {
		if (shouldClearGroupHistory) params.groupHistories.set(params.groupHistoryKey, []);
		logVerbose("Skipping auto-reply: silent token or no text/media returned from resolver");
		return false;
	}
	if (shouldClearGroupHistory) params.groupHistories.set(params.groupHistoryKey, []);
	return didSendReply;
}

//#endregion
//#region src/web/auto-reply/monitor/on-message.ts
function createWebOnMessageHandler(params) {
	const processForRoute = async (msg, route, groupHistoryKey, opts) => processMessage({
		cfg: params.cfg,
		msg,
		route,
		groupHistoryKey,
		groupHistories: params.groupHistories,
		groupMemberNames: params.groupMemberNames,
		connectionId: params.connectionId,
		verbose: params.verbose,
		maxMediaBytes: params.maxMediaBytes,
		replyResolver: params.replyResolver,
		replyLogger: params.replyLogger,
		backgroundTasks: params.backgroundTasks,
		rememberSentText: params.echoTracker.rememberText,
		echoHas: params.echoTracker.has,
		echoForget: params.echoTracker.forget,
		buildCombinedEchoKey: params.echoTracker.buildCombinedKey,
		groupHistory: opts?.groupHistory,
		suppressGroupHistoryClear: opts?.suppressGroupHistoryClear
	});
	return async (msg) => {
		const conversationId = msg.conversationId ?? msg.from;
		const peerId = resolvePeerId(msg);
		const route = resolveAgentRoute({
			cfg: loadConfig(),
			channel: "whatsapp",
			accountId: msg.accountId,
			peer: {
				kind: msg.chatType === "group" ? "group" : "direct",
				id: peerId
			}
		});
		const groupHistoryKey = msg.chatType === "group" ? buildGroupHistoryKey({
			channel: "whatsapp",
			accountId: route.accountId,
			peerKind: "group",
			peerId
		}) : route.sessionKey;
		if (msg.from === msg.to) logVerbose(`📱 Same-phone mode detected (from === to: ${msg.from})`);
		if (params.echoTracker.has(msg.body)) {
			logVerbose("Skipping auto-reply: detected echo (message matches recently sent text)");
			params.echoTracker.forget(msg.body);
			return;
		}
		if (msg.chatType === "group") {
			const metaCtx = {
				From: msg.from,
				To: msg.to,
				SessionKey: route.sessionKey,
				AccountId: route.accountId,
				ChatType: msg.chatType,
				ConversationLabel: conversationId,
				GroupSubject: msg.groupSubject,
				SenderName: msg.senderName,
				SenderId: msg.senderJid?.trim() || msg.senderE164,
				SenderE164: msg.senderE164,
				Provider: "whatsapp",
				Surface: "whatsapp",
				OriginatingChannel: "whatsapp",
				OriginatingTo: conversationId
			};
			updateLastRouteInBackground({
				cfg: params.cfg,
				backgroundTasks: params.backgroundTasks,
				storeAgentId: route.agentId,
				sessionKey: route.sessionKey,
				channel: "whatsapp",
				to: conversationId,
				accountId: route.accountId,
				ctx: metaCtx,
				warn: params.replyLogger.warn.bind(params.replyLogger)
			});
			if (!applyGroupGating({
				cfg: params.cfg,
				msg,
				conversationId,
				groupHistoryKey,
				agentId: route.agentId,
				sessionKey: route.sessionKey,
				baseMentionConfig: params.baseMentionConfig,
				authDir: params.account.authDir,
				groupHistories: params.groupHistories,
				groupHistoryLimit: params.groupHistoryLimit,
				groupMemberNames: params.groupMemberNames,
				logVerbose,
				replyLogger: params.replyLogger
			}).shouldProcess) return;
		} else if (!msg.senderE164 && peerId && peerId.startsWith("+")) msg.senderE164 = normalizeE164(peerId) ?? msg.senderE164;
		if (await maybeBroadcastMessage({
			cfg: params.cfg,
			msg,
			peerId,
			route,
			groupHistoryKey,
			groupHistories: params.groupHistories,
			processMessage: processForRoute
		})) return;
		await processForRoute(msg, route, groupHistoryKey);
	};
}

//#endregion
//#region src/web/auto-reply/monitor.ts
function isNonRetryableWebCloseStatus(statusCode) {
	return statusCode === 440;
}
async function monitorWebChannel(verbose, listenerFactory = monitorWebInbox, keepAlive = true, replyResolver = getReplyFromConfig, runtime = defaultRuntime, abortSignal, tuning = {}) {
	const runId = newConnectionId();
	const replyLogger = getChildLogger({
		module: "web-auto-reply",
		runId
	});
	const heartbeatLogger = getChildLogger({
		module: "web-heartbeat",
		runId
	});
	const reconnectLogger = getChildLogger({
		module: "web-reconnect",
		runId
	});
	const status = {
		running: true,
		connected: false,
		reconnectAttempts: 0,
		lastConnectedAt: null,
		lastDisconnect: null,
		lastMessageAt: null,
		lastEventAt: null,
		lastError: null
	};
	const emitStatus = () => {
		tuning.statusSink?.({
			...status,
			lastDisconnect: status.lastDisconnect ? { ...status.lastDisconnect } : null
		});
	};
	emitStatus();
	const baseCfg = loadConfig();
	const account = resolveWhatsAppAccount({
		cfg: baseCfg,
		accountId: tuning.accountId
	});
	const cfg = {
		...baseCfg,
		channels: {
			...baseCfg.channels,
			whatsapp: {
				...baseCfg.channels?.whatsapp,
				ackReaction: account.ackReaction,
				messagePrefix: account.messagePrefix,
				allowFrom: account.allowFrom,
				groupAllowFrom: account.groupAllowFrom,
				groupPolicy: account.groupPolicy,
				textChunkLimit: account.textChunkLimit,
				chunkMode: account.chunkMode,
				mediaMaxMb: account.mediaMaxMb,
				blockStreaming: account.blockStreaming,
				groups: account.groups
			}
		}
	};
	const configuredMaxMb = cfg.agents?.defaults?.mediaMaxMb;
	const maxMediaBytes = typeof configuredMaxMb === "number" && configuredMaxMb > 0 ? configuredMaxMb * 1024 * 1024 : DEFAULT_WEB_MEDIA_BYTES;
	const heartbeatSeconds = resolveHeartbeatSeconds(cfg, tuning.heartbeatSeconds);
	const reconnectPolicy = resolveReconnectPolicy(cfg, tuning.reconnect);
	const baseMentionConfig = buildMentionConfig(cfg);
	const groupHistoryLimit = cfg.channels?.whatsapp?.accounts?.[tuning.accountId ?? ""]?.historyLimit ?? cfg.channels?.whatsapp?.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT;
	const groupHistories = /* @__PURE__ */ new Map();
	const groupMemberNames = /* @__PURE__ */ new Map();
	const echoTracker = createEchoTracker({
		maxItems: 100,
		logVerbose
	});
	const sleep = tuning.sleep ?? ((ms, signal) => sleepWithAbort(ms, signal ?? abortSignal));
	const stopRequested = () => abortSignal?.aborted === true;
	const abortPromise = abortSignal && new Promise((resolve) => abortSignal.addEventListener("abort", () => resolve("aborted"), { once: true }));
	const currentMaxListeners = process.getMaxListeners?.() ?? 10;
	if (process.setMaxListeners && currentMaxListeners < 50) process.setMaxListeners(50);
	let sigintStop = false;
	const handleSigint = () => {
		sigintStop = true;
	};
	process.once("SIGINT", handleSigint);
	let reconnectAttempts = 0;
	while (true) {
		if (stopRequested()) break;
		const connectionId = newConnectionId();
		const startedAt = Date.now();
		let heartbeat = null;
		let watchdogTimer = null;
		let lastMessageAt = null;
		let handledMessages = 0;
		let unregisterUnhandled = null;
		const MESSAGE_TIMEOUT_MS = tuning.messageTimeoutMs ?? 1800 * 1e3;
		const WATCHDOG_CHECK_MS = tuning.watchdogCheckMs ?? 60 * 1e3;
		const backgroundTasks = /* @__PURE__ */ new Set();
		const onMessage = createWebOnMessageHandler({
			cfg,
			verbose,
			connectionId,
			maxMediaBytes,
			groupHistoryLimit,
			groupHistories,
			groupMemberNames,
			echoTracker,
			backgroundTasks,
			replyResolver: replyResolver ?? getReplyFromConfig,
			replyLogger,
			baseMentionConfig,
			account
		});
		const inboundDebounceMs = resolveInboundDebounceMs({
			cfg,
			channel: "whatsapp"
		});
		const shouldDebounce = (msg) => {
			if (msg.mediaPath || msg.mediaType) return false;
			if (msg.location) return false;
			if (msg.replyToId || msg.replyToBody) return false;
			return !hasControlCommand(msg.body, cfg);
		};
		const listener = await (listenerFactory ?? monitorWebInbox)({
			verbose,
			accountId: account.accountId,
			authDir: account.authDir,
			mediaMaxMb: account.mediaMaxMb,
			sendReadReceipts: account.sendReadReceipts,
			debounceMs: inboundDebounceMs,
			shouldDebounce,
			onMessage: async (msg) => {
				handledMessages += 1;
				lastMessageAt = Date.now();
				status.lastMessageAt = lastMessageAt;
				status.lastEventAt = lastMessageAt;
				emitStatus();
				await onMessage(msg);
			}
		});
		status.connected = true;
		status.lastConnectedAt = Date.now();
		status.lastEventAt = status.lastConnectedAt;
		status.lastError = null;
		emitStatus();
		const { e164: selfE164 } = readWebSelfId(account.authDir);
		const connectRoute = resolveAgentRoute({
			cfg,
			channel: "whatsapp",
			accountId: account.accountId
		});
		enqueueSystemEvent(`WhatsApp gateway connected${selfE164 ? ` as ${selfE164}` : ""}.`, { sessionKey: connectRoute.sessionKey });
		setActiveWebListener(account.accountId, listener);
		unregisterUnhandled = registerUnhandledRejectionHandler((reason) => {
			if (!isLikelyWhatsAppCryptoError(reason)) return false;
			const errorStr = formatError(reason);
			reconnectLogger.warn({
				connectionId,
				error: errorStr
			}, "web reconnect: unhandled rejection from WhatsApp socket; forcing reconnect");
			listener.signalClose?.({
				status: 499,
				isLoggedOut: false,
				error: reason
			});
			return true;
		});
		const closeListener = async () => {
			setActiveWebListener(account.accountId, null);
			if (unregisterUnhandled) {
				unregisterUnhandled();
				unregisterUnhandled = null;
			}
			if (heartbeat) clearInterval(heartbeat);
			if (watchdogTimer) clearInterval(watchdogTimer);
			if (backgroundTasks.size > 0) {
				await Promise.allSettled(backgroundTasks);
				backgroundTasks.clear();
			}
			try {
				await listener.close();
			} catch (err) {
				logVerbose(`Socket close failed: ${formatError(err)}`);
			}
		};
		if (keepAlive) {
			heartbeat = setInterval(() => {
				const authAgeMs = getWebAuthAgeMs(account.authDir);
				const minutesSinceLastMessage = lastMessageAt ? Math.floor((Date.now() - lastMessageAt) / 6e4) : null;
				const logData = {
					connectionId,
					reconnectAttempts,
					messagesHandled: handledMessages,
					lastMessageAt,
					authAgeMs,
					uptimeMs: Date.now() - startedAt,
					...minutesSinceLastMessage !== null && minutesSinceLastMessage > 30 ? { minutesSinceLastMessage } : {}
				};
				if (minutesSinceLastMessage && minutesSinceLastMessage > 30) heartbeatLogger.warn(logData, "⚠️ web gateway heartbeat - no messages in 30+ minutes");
				else heartbeatLogger.info(logData, "web gateway heartbeat");
			}, heartbeatSeconds * 1e3);
			watchdogTimer = setInterval(() => {
				if (!lastMessageAt) return;
				const timeSinceLastMessage = Date.now() - lastMessageAt;
				if (timeSinceLastMessage <= MESSAGE_TIMEOUT_MS) return;
				const minutesSinceLastMessage = Math.floor(timeSinceLastMessage / 6e4);
				heartbeatLogger.warn({
					connectionId,
					minutesSinceLastMessage,
					lastMessageAt: new Date(lastMessageAt),
					messagesHandled: handledMessages
				}, "Message timeout detected - forcing reconnect");
				whatsappHeartbeatLog.warn(`No messages received in ${minutesSinceLastMessage}m - restarting connection`);
				closeListener().catch((err) => {
					logVerbose(`Close listener failed: ${formatError(err)}`);
				});
				listener.signalClose?.({
					status: 499,
					isLoggedOut: false,
					error: "watchdog-timeout"
				});
			}, WATCHDOG_CHECK_MS);
		}
		whatsappLog.info("Listening for personal WhatsApp inbound messages.");
		if (process.stdout.isTTY || process.stderr.isTTY) whatsappLog.raw("Ctrl+C to stop.");
		if (!keepAlive) {
			await closeListener();
			process.removeListener("SIGINT", handleSigint);
			return;
		}
		const reason = await Promise.race([listener.onClose?.catch((err) => {
			reconnectLogger.error({ error: formatError(err) }, "listener.onClose rejected");
			return {
				status: 500,
				isLoggedOut: false,
				error: err
			};
		}) ?? waitForever(), abortPromise ?? waitForever()]);
		if (Date.now() - startedAt > heartbeatSeconds * 1e3) reconnectAttempts = 0;
		status.reconnectAttempts = reconnectAttempts;
		emitStatus();
		if (stopRequested() || sigintStop || reason === "aborted") {
			await closeListener();
			break;
		}
		const statusCode = (typeof reason === "object" && reason && "status" in reason ? reason.status : void 0) ?? "unknown";
		const loggedOut = typeof reason === "object" && reason && "isLoggedOut" in reason && reason.isLoggedOut;
		const errorStr = formatError(reason);
		status.connected = false;
		status.lastEventAt = Date.now();
		status.lastDisconnect = {
			at: status.lastEventAt,
			status: typeof statusCode === "number" ? statusCode : void 0,
			error: errorStr,
			loggedOut: Boolean(loggedOut)
		};
		status.lastError = errorStr;
		status.reconnectAttempts = reconnectAttempts;
		emitStatus();
		reconnectLogger.info({
			connectionId,
			status: statusCode,
			loggedOut,
			reconnectAttempts,
			error: errorStr
		}, "web reconnect: connection closed");
		enqueueSystemEvent(`WhatsApp gateway disconnected (status ${statusCode ?? "unknown"})`, { sessionKey: connectRoute.sessionKey });
		if (loggedOut) {
			runtime.error(`WhatsApp session logged out. Run \`${formatCliCommand("openclaw channels login --channel web")}\` to relink.`);
			await closeListener();
			break;
		}
		if (isNonRetryableWebCloseStatus(statusCode)) {
			reconnectLogger.warn({
				connectionId,
				status: statusCode,
				error: errorStr
			}, "web reconnect: non-retryable close status; stopping monitor");
			runtime.error(`WhatsApp Web connection closed (status ${statusCode}: session conflict). Resolve conflicting WhatsApp Web sessions, then relink with \`${formatCliCommand("openclaw channels login --channel web")}\`. Stopping web monitoring.`);
			await closeListener();
			break;
		}
		reconnectAttempts += 1;
		status.reconnectAttempts = reconnectAttempts;
		emitStatus();
		if (reconnectPolicy.maxAttempts > 0 && reconnectAttempts >= reconnectPolicy.maxAttempts) {
			reconnectLogger.warn({
				connectionId,
				status: statusCode,
				reconnectAttempts,
				maxAttempts: reconnectPolicy.maxAttempts
			}, "web reconnect: max attempts reached; continuing in degraded mode");
			runtime.error(`WhatsApp Web reconnect: max attempts reached (${reconnectAttempts}/${reconnectPolicy.maxAttempts}). Stopping web monitoring.`);
			await closeListener();
			break;
		}
		const delay = computeBackoff(reconnectPolicy, reconnectAttempts);
		reconnectLogger.info({
			connectionId,
			status: statusCode,
			reconnectAttempts,
			maxAttempts: reconnectPolicy.maxAttempts || "unlimited",
			delayMs: delay
		}, "web reconnect: scheduling retry");
		runtime.error(`WhatsApp Web connection closed (status ${statusCode}). Retry ${reconnectAttempts}/${reconnectPolicy.maxAttempts || "∞"} in ${formatDurationPrecise(delay)}… (${errorStr})`);
		await closeListener();
		try {
			await sleep(delay, abortSignal);
		} catch {
			break;
		}
	}
	status.running = false;
	status.connected = false;
	status.lastEventAt = Date.now();
	emitStatus();
	process.removeListener("SIGINT", handleSigint);
}

//#endregion
export { monitorWebInbox as n, waitForever as r, monitorWebChannel as t };