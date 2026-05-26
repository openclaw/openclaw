import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { r as logVerbose } from "./globals-YU5FjfZK.js";
import "./runtime-env-BtvWnLRh.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./state-paths-iYyQ0JoC.js";
import fs from "node:fs";
import path from "node:path";
//#region extensions/imessage/src/monitor-reply-cache.ts
const REPLY_CACHE_MAX = 2e3;
const REPLY_CACHE_TTL_MS = 360 * 60 * 1e3;
/** Recency window for the "react to the latest message" fallback. */
const LATEST_FALLBACK_MS = 600 * 1e3;
let persistenceFailureLogged = false;
let parseFailureLogged = false;
function reportPersistenceFailure(scope, err) {
	if (persistenceFailureLogged) return;
	persistenceFailureLogged = true;
	logVerbose(`imessage reply-cache: ${scope} disabled after first failure: ${String(err)}`);
}
const imessageReplyCacheByMessageId = /* @__PURE__ */ new Map();
const imessageShortIdToUuid = /* @__PURE__ */ new Map();
const imessageUuidToShortId = /* @__PURE__ */ new Map();
let imessageShortIdCounter = 0;
function resolveReplyCachePath() {
	return path.join(resolveStateDir(), "imessage", "reply-cache.jsonl");
}
function readPersistedEntries() {
	let raw;
	try {
		raw = fs.readFileSync(resolveReplyCachePath(), "utf8");
	} catch (err) {
		if (err?.code !== "ENOENT") reportPersistenceFailure("read", err);
		return {
			entries: [],
			maxObservedShortId: 0
		};
	}
	const cutoff = Date.now() - REPLY_CACHE_TTL_MS;
	const out = [];
	let maxObservedShortId = 0;
	for (const line of raw.split(/\n+/)) {
		if (!line) continue;
		let parsed = null;
		try {
			parsed = JSON.parse(line);
		} catch {
			if (!parseFailureLogged) {
				parseFailureLogged = true;
				logVerbose(`imessage reply-cache: dropping unparseable line (further parse errors suppressed)`);
			}
			continue;
		}
		if (parsed && typeof parsed.shortId === "string") {
			const numeric = Number.parseInt(parsed.shortId, 10);
			if (Number.isFinite(numeric) && numeric > maxObservedShortId) maxObservedShortId = numeric;
		}
		if (typeof parsed?.accountId !== "string" || typeof parsed.messageId !== "string" || typeof parsed.shortId !== "string" || typeof parsed.timestamp !== "number") continue;
		if (parsed.timestamp < cutoff) continue;
		out.push({
			accountId: parsed.accountId,
			messageId: parsed.messageId,
			shortId: parsed.shortId,
			timestamp: parsed.timestamp,
			chatGuid: typeof parsed.chatGuid === "string" ? parsed.chatGuid : void 0,
			chatIdentifier: typeof parsed.chatIdentifier === "string" ? parsed.chatIdentifier : void 0,
			chatId: typeof parsed.chatId === "number" ? parsed.chatId : void 0,
			isFromMe: typeof parsed.isFromMe === "boolean" ? parsed.isFromMe : void 0
		});
	}
	return {
		entries: out.slice(-2e3),
		maxObservedShortId
	};
}
const REPLY_CACHE_DIR_MODE = 448;
const REPLY_CACHE_FILE_MODE = 384;
function writePersistedEntries(entries) {
	const filePath = resolveReplyCachePath();
	try {
		fs.mkdirSync(path.dirname(filePath), {
			recursive: true,
			mode: REPLY_CACHE_DIR_MODE
		});
		fs.writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""), {
			encoding: "utf8",
			mode: REPLY_CACHE_FILE_MODE
		});
		try {
			fs.chmodSync(path.dirname(filePath), REPLY_CACHE_DIR_MODE);
			fs.chmodSync(filePath, REPLY_CACHE_FILE_MODE);
		} catch {}
	} catch (err) {
		reportPersistenceFailure("write", err);
	}
}
function appendPersistedEntry(entry) {
	const filePath = resolveReplyCachePath();
	try {
		fs.mkdirSync(path.dirname(filePath), {
			recursive: true,
			mode: REPLY_CACHE_DIR_MODE
		});
		fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, {
			encoding: "utf8",
			mode: REPLY_CACHE_FILE_MODE
		});
		try {
			fs.chmodSync(path.dirname(filePath), REPLY_CACHE_DIR_MODE);
			fs.chmodSync(filePath, REPLY_CACHE_FILE_MODE);
		} catch {}
	} catch (err) {
		reportPersistenceFailure("append", err);
	}
}
let hydrated = false;
function hydrateFromDiskOnce() {
	if (hydrated) return;
	hydrated = true;
	const { entries, maxObservedShortId } = readPersistedEntries();
	if (maxObservedShortId > imessageShortIdCounter) imessageShortIdCounter = maxObservedShortId;
	if (entries.length === 0) return;
	for (const entry of entries) {
		imessageReplyCacheByMessageId.set(entry.messageId, entry);
		imessageShortIdToUuid.set(entry.shortId, entry.messageId);
		imessageUuidToShortId.set(entry.messageId, entry.shortId);
	}
}
function generateShortId() {
	imessageShortIdCounter += 1;
	return String(imessageShortIdCounter);
}
function rememberIMessageReplyCache(entry) {
	hydrateFromDiskOnce();
	const messageId = entry.messageId.trim();
	if (!messageId) return {
		...entry,
		shortId: ""
	};
	let shortId = imessageUuidToShortId.get(messageId);
	let allocatedNew = false;
	if (!shortId) {
		shortId = generateShortId();
		imessageShortIdToUuid.set(shortId, messageId);
		imessageUuidToShortId.set(messageId, shortId);
		allocatedNew = true;
	}
	const fullEntry = {
		...entry,
		messageId,
		shortId
	};
	imessageReplyCacheByMessageId.delete(messageId);
	imessageReplyCacheByMessageId.set(messageId, fullEntry);
	const cutoff = Date.now() - REPLY_CACHE_TTL_MS;
	let evicted = false;
	for (const [key, value] of imessageReplyCacheByMessageId) {
		if (value.timestamp >= cutoff) break;
		imessageReplyCacheByMessageId.delete(key);
		if (value.shortId) {
			imessageShortIdToUuid.delete(value.shortId);
			imessageUuidToShortId.delete(key);
		}
		evicted = true;
	}
	while (imessageReplyCacheByMessageId.size > REPLY_CACHE_MAX) {
		const oldest = imessageReplyCacheByMessageId.keys().next().value;
		if (!oldest) break;
		const oldEntry = imessageReplyCacheByMessageId.get(oldest);
		imessageReplyCacheByMessageId.delete(oldest);
		if (oldEntry?.shortId) {
			imessageShortIdToUuid.delete(oldEntry.shortId);
			imessageUuidToShortId.delete(oldest);
		}
		evicted = true;
	}
	if (allocatedNew) appendPersistedEntry(fullEntry);
	if (evicted) writePersistedEntries([...imessageReplyCacheByMessageId.values()]);
	return fullEntry;
}
function hasChatScope(ctx) {
	if (!ctx) return false;
	return Boolean(normalizeOptionalString(ctx.chatGuid) || normalizeOptionalString(ctx.chatIdentifier) || typeof ctx.chatId === "number");
}
/**
* Strip the `iMessage;-;` / `SMS;-;` / `any;-;` service prefix that Messages
* uses for direct chats. Different layers report direct DMs in different
* forms — imsg's watch emits the bare handle plus an `any;-;…` chat_guid,
* the action surface synthesizes `iMessage;-;…` from a phone-number target —
* so comparing the raw strings would falsely flag the same chat as a
* cross-chat target. Normalize both sides to the bare suffix.
*/
function normalizeDirectChatIdentifier(raw) {
	const trimmed = raw.trim();
	const lowered = trimmed.toLowerCase();
	for (const prefix of [
		"imessage;-;",
		"sms;-;",
		"any;-;"
	]) if (lowered.startsWith(prefix)) return trimmed.slice(prefix.length);
	return trimmed;
}
function isCrossChatMismatch(cached, ctx) {
	const cachedChatGuid = normalizeOptionalString(cached.chatGuid);
	const ctxChatGuid = normalizeOptionalString(ctx.chatGuid);
	if (cachedChatGuid && ctxChatGuid) {
		if (normalizeDirectChatIdentifier(cachedChatGuid) === normalizeDirectChatIdentifier(ctxChatGuid)) return false;
		return cachedChatGuid !== ctxChatGuid;
	}
	const cachedChatIdentifier = normalizeOptionalString(cached.chatIdentifier);
	const ctxChatIdentifier = normalizeOptionalString(ctx.chatIdentifier);
	if (cachedChatIdentifier && ctxChatIdentifier) {
		if (normalizeDirectChatIdentifier(cachedChatIdentifier) === normalizeDirectChatIdentifier(ctxChatIdentifier)) return false;
		return cachedChatIdentifier !== ctxChatIdentifier;
	}
	const cachedChatId = typeof cached.chatId === "number" ? cached.chatId : void 0;
	const ctxChatId = typeof ctx.chatId === "number" ? ctx.chatId : void 0;
	if (cachedChatId !== void 0 && ctxChatId !== void 0) return cachedChatId !== ctxChatId;
	const cachedFingerprint = cachedChatGuid ? normalizeDirectChatIdentifier(cachedChatGuid) : cachedChatIdentifier ? normalizeDirectChatIdentifier(cachedChatIdentifier) : void 0;
	const ctxFingerprint = ctxChatGuid ? normalizeDirectChatIdentifier(ctxChatGuid) : ctxChatIdentifier ? normalizeDirectChatIdentifier(ctxChatIdentifier) : void 0;
	if (cachedFingerprint && ctxFingerprint) return cachedFingerprint !== ctxFingerprint;
	return false;
}
function describeChatForError(values) {
	const parts = [];
	if (normalizeOptionalString(values.chatGuid)) parts.push("chatGuid=<redacted>");
	if (normalizeOptionalString(values.chatIdentifier)) parts.push("chatIdentifier=<redacted>");
	if (typeof values.chatId === "number") parts.push("chatId=<redacted>");
	return parts.length === 0 ? "<unknown chat>" : parts.join(", ");
}
function describeMessageIdForError(inputId, inputKind) {
	if (inputKind === "short") return `<short:${inputId.length}-digit>`;
	return `<uuid:${inputId.slice(0, 8)}...>`;
}
function buildCrossChatError(inputId, inputKind, cached, ctx) {
	const remediation = inputKind === "short" ? "Retry with MessageSidFull to avoid cross-chat reactions/replies landing in the wrong conversation." : "Retry with the correct chat target.";
	return /* @__PURE__ */ new Error(`iMessage message id ${describeMessageIdForError(inputId, inputKind)} belongs to a different chat (${describeChatForError(cached)}) than the current call target (${describeChatForError(ctx)}). ${remediation}`);
}
function resolveIMessageMessageId(shortOrUuid, opts) {
	const trimmed = shortOrUuid.trim();
	if (!trimmed) return trimmed;
	hydrateFromDiskOnce();
	if (/^\d+$/.test(trimmed)) {
		const uuid = imessageShortIdToUuid.get(trimmed);
		if (uuid) {
			const cached = imessageReplyCacheByMessageId.get(uuid);
			if (opts?.chatContext && hasChatScope(opts.chatContext)) {
				if (cached && isCrossChatMismatch(cached, opts.chatContext)) throw buildCrossChatError(trimmed, "short", cached, opts.chatContext);
			}
			if (opts?.requireFromMe && cached?.isFromMe !== true) throw buildFromMeError(trimmed, "short");
			return uuid;
		}
		if (opts?.requireKnownShortId && !hasChatScope(opts.chatContext)) throw new Error(`iMessage short message id ${describeMessageIdForError(trimmed, "short")} requires a chat scope (chatGuid / chatIdentifier / chatId or a target).`);
		if (opts?.requireKnownShortId) throw new Error(`iMessage short message id ${describeMessageIdForError(trimmed, "short")} is no longer available. Use MessageSidFull.`);
		return trimmed;
	}
	const cached = imessageReplyCacheByMessageId.get(trimmed);
	if (opts?.chatContext) {
		if (cached && isCrossChatMismatch(cached, opts.chatContext)) throw buildCrossChatError(trimmed, "uuid", cached, opts.chatContext);
	}
	if (opts?.requireFromMe && cached?.isFromMe !== true) throw buildFromMeError(trimmed, "uuid");
	return trimmed;
}
function isKnownFromMeIMessageMessageId(messageId, ctx) {
	const trimmed = normalizeOptionalString(messageId);
	if (!trimmed || !ctx.accountId || !hasChatScope(ctx)) return false;
	hydrateFromDiskOnce();
	const cached = imessageReplyCacheByMessageId.get(trimmed);
	if (!cached || cached.isFromMe !== true || cached.accountId !== ctx.accountId) return false;
	return isPositiveChatMatch(cached, ctx);
}
function buildFromMeError(inputId, inputKind) {
	return /* @__PURE__ */ new Error(`iMessage message id ${describeMessageIdForError(inputId, inputKind)} is not one this agent sent. edit and unsend can only target messages the gateway delivered itself; messages received from other participants cannot be modified.`);
}
/**
* Return the most recent cached entry whose chat scope matches the supplied
* context. Used as a fallback when an agent calls a per-message action (e.g.
* `react`) without specifying a `messageId` — the natural intent is "react
* to the message I just received in this chat."
*
* Strict semantics for safety:
*  - Caller must supply a chat scope. We refuse to "guess" the active chat.
*  - Cached entry must positively match on at least one identifier kind
*    (chatGuid, chatIdentifier, chatId, or normalized direct-DM fingerprint).
*    We do NOT fall through on "no overlapping identifier" — that's how a
*    cached entry from a foreign chat could be returned when the caller's
*    context didn't share any identifier kind with the cache.
*  - Caller must supply an accountId; we never cross account boundaries.
*  - We only consider entries newer than `LATEST_FALLBACK_MS`. The intent
*    of "react to the latest" is "the message I just received," not
*    "anything in this chat from any time."
*/
function findLatestIMessageEntryForChat(ctx) {
	if (!hasChatScope(ctx)) return;
	if (!ctx.accountId) return;
	const cutoff = Date.now() - LATEST_FALLBACK_MS;
	let best;
	for (const entry of imessageReplyCacheByMessageId.values()) {
		if (entry.accountId !== ctx.accountId) continue;
		if (entry.timestamp < cutoff) continue;
		if (!isPositiveChatMatch(entry, ctx)) continue;
		if (!best || entry.timestamp > best.timestamp) best = entry;
	}
	return best;
}
/**
* Return true when the cached entry positively matches the caller's chat
* context on at least one identifier kind. Unlike `isCrossChatMismatch`,
* which returns false for "no overlap," this requires concrete agreement.
*/
function isPositiveChatMatch(entry, ctx) {
	const cachedChatGuid = normalizeOptionalString(entry.chatGuid);
	const ctxChatGuid = normalizeOptionalString(ctx.chatGuid);
	if (cachedChatGuid && ctxChatGuid && cachedChatGuid === ctxChatGuid) return true;
	const cachedChatIdentifier = normalizeOptionalString(entry.chatIdentifier);
	const ctxChatIdentifier = normalizeOptionalString(ctx.chatIdentifier);
	if (cachedChatIdentifier && ctxChatIdentifier && cachedChatIdentifier === ctxChatIdentifier) return true;
	if (typeof entry.chatId === "number" && typeof ctx.chatId === "number" && entry.chatId === ctx.chatId) return true;
	const cachedFingerprint = cachedChatGuid ? normalizeDirectChatIdentifier(cachedChatGuid) : cachedChatIdentifier ? normalizeDirectChatIdentifier(cachedChatIdentifier) : void 0;
	const ctxFingerprint = ctxChatGuid ? normalizeDirectChatIdentifier(ctxChatGuid) : ctxChatIdentifier ? normalizeDirectChatIdentifier(ctxChatIdentifier) : void 0;
	if (cachedFingerprint && ctxFingerprint && cachedFingerprint === ctxFingerprint) return true;
	return false;
}
//#endregion
export { resolveIMessageMessageId as i, isKnownFromMeIMessageMessageId as n, rememberIMessageReplyCache as r, findLatestIMessageEntryForChat as t };
