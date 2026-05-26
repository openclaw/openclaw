import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { c as isRecord, y as truncateUtf16Safe } from "./utils-sBTEdeml.js";
import { s as normalizeStringEntries } from "./string-normalization-DiPHgdft.js";
import { t as createNonExitingRuntime } from "./runtime-yzlkhCoS.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C60hWKdY.js";
import { a as shouldLogVerbose, r as logVerbose, s as warn, t as danger } from "./globals-YU5FjfZK.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { t as sanitizeTerminalText } from "./safe-text-J_0sTthZ.js";
import { u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { a as readSessionUpdatedAt } from "./store-BmtchQvp.js";
import { c as kindFromMime } from "./mime-DppuT-pZ.js";
import { a as enqueueSystemEvent } from "./system-events-11EG3LzK.js";
import { h as isInsideCode, m as findCodeRegions } from "./assistant-visible-text-BoF6Ixue.js";
import { r as stripInlineDirectiveTagsForDelivery } from "./directive-tags-CClLEtM7.js";
import { i as writeJsonFileAtomically, n as readJsonFileWithFallback } from "./json-store-ChgPP2Sf.js";
import { a as settleReplyDispatcher, t as dispatchInboundMessage } from "./dispatch-cQjCJvZr.js";
import { i as deliverTextOrMediaReply, m as resolveSendableOutboundReplyParts } from "./reply-payload-DMPQsrQC.js";
import { n as resolveChannelGroupRequireMention, t as resolveChannelGroupPolicy } from "./group-policy-sKF5rlUN.js";
import { a as resolveInboundLastRouteSessionKey, i as resolveAgentRoute } from "./resolve-route-C8IahAyG.js";
import { a as readChannelAllowFromStore, d as upsertChannelPairingRequest } from "./pairing-store-jPMfFWFn.js";
import { n as resolveInboundMentionDecision } from "./mention-gating-3P8aSD7o.js";
import { c as defineStableChannelIngressIdentity, n as createChannelIngressResolver } from "./runtime-BUVuto5K.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, i as resolveOpenProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "./runtime-group-policy-CmZDlIwd.js";
import { l as resolvePinnedMainDmOwnerFromAllowlist } from "./dm-policy-shared-CXEKnzKD.js";
import { u as saveMediaBuffer } from "./store-rQFzzX5P.js";
import { t as loadWebMedia } from "./web-media-GlH39bZn.js";
import { i as resolveHumanDelayConfig } from "./identity-nYw-h8DL.js";
import { c as resolveTextChunkLimit, o as chunkTextWithMode, s as resolveChunkMode } from "./chunk-IIklKK4Y.js";
import { t as createMessageReceiptFromOutboundResults } from "./receipt-vrVTwZtS.js";
import { t as isInboundPathAllowed } from "./inbound-path-policy-DEbcUBWg.js";
import "./temp-path-DllZid8c.js";
import { t as resolveOutboundAttachmentFromUrl } from "./outbound-attachment-DzcpomLF.js";
import { n as buildMentionRegexes, r as matchesMentionPatterns } from "./mentions-DmNrCnsQ.js";
import { n as createReplyDispatcherWithTyping } from "./reply-dispatcher-DPt1UxjJ.js";
import { t as finalizeInboundContext } from "./inbound-context-Cg0uCtqQ.js";
import "./runtime-env-BtvWnLRh.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./state-paths-iYyQ0JoC.js";
import "./routing-79DRZvfm.js";
import { t as hasControlCommand } from "./command-detection-CC0FOFv2.js";
import { a as resolveEnvelopeFormatOptions, i as formatInboundFromLabel, r as formatInboundEnvelope } from "./envelope-DUI2KFD9.js";
import { t as recordInboundSession } from "./session-CCAfHrW1.js";
import "./history-BD_TtuvO.js";
import { t as createChannelReplyPipeline } from "./reply-pipeline-EtNTatED.js";
import { t as evaluateSupplementalContextVisibility } from "./context-visibility-C9pX_aod.js";
import { t as createChannelHistoryWindow } from "./history-window-Gy0CzEef.js";
import { t as resolveMarkdownTableMode } from "./markdown-tables-DCRkoyVz.js";
import { t as convertMarkdownTables } from "./tables-D3y68tNR.js";
import "./channel-policy-pv8ZpZxj.js";
import "./reply-history-Dd_Mx-HZ.js";
import { t as requireRuntimeConfig } from "./plugin-config-runtime-DWa7yCpn.js";
import { t as resolveChannelContextVisibilityMode } from "./context-visibility-Si-TIKp_.js";
import "./reply-runtime-DbNBMCwV.js";
import { d as runInboundReplyTurn } from "./inbound-reply-dispatch-Bi01ox5N.js";
import { t as waitForTransportReady } from "./transport-ready-BJHvYgtu.js";
import "./web-media-Q6WLwwDo.js";
import "./system-event-runtime-DldWy4vd.js";
import "./transport-ready-runtime-IjPfSFuM.js";
import { r as normalizeScpRemoteHost } from "./scp-host-CIH1Vnml.js";
import "./runtime-config-snapshot-BBsNBtE3.js";
import "./media-runtime-BheBFFxc.js";
import "./media-store-3-Nw2YTP.js";
import { n as resolveConfiguredBindingRoute, r as resolveRuntimeConversationBindingRoute } from "./binding-routing-DfoE5KF_.js";
import "./conversation-runtime-guwDSNIo.js";
import "./text-chunking-C154U6-i.js";
import "./agent-runtime-Lc7H-PlR.js";
import "./security-runtime-CcSekjBd.js";
import "./markdown-table-runtime-BRMInqmJ.js";
import "./command-auth-native-BhcKSceK.js";
import { n as logInboundDrop, r as logTypingFailure } from "./logging-Dr3f0mtP.js";
import "./channel-feedback-Bn34MjYD.js";
import { o as createChannelInboundDebouncer, s as shouldDebounceTextInbound } from "./channel-inbound-C7GtKjtG.js";
import "./channel-ingress-runtime-C3bbz3sX.js";
import { a as deliverInboundReplyWithMessageSendContext } from "./channel-message-DMGbyII_.js";
import { t as createChannelPairingChallengeIssuer } from "./channel-pairing-N4dBc-K-.js";
import "./session-store-runtime-DCQkOAps.js";
import "./text-utility-runtime-CaGXarh9.js";
import { i as resolveIMessageAccount } from "./accounts-G6A_hywc.js";
import { t as createIMessageRpcClient } from "./client-BcN4Qxqo.js";
import { n as imessageRpcSupportsMethod, t as getCachedIMessagePrivateApiStatus } from "./private-api-status-hXzk6Zzf.js";
import { c as parseIMessageTarget, o as normalizeIMessageHandle, r as isAllowedIMessageReplyContextSender, s as parseIMessageAllowTarget, t as formatIMessageChatTarget } from "./targets-C7radLf6.js";
import { n as isKnownFromMeIMessageMessageId, r as rememberIMessageReplyCache } from "./monitor-reply-cache-VQxHiKhg.js";
import { t as probeIMessage } from "./probe-DlyCigli.js";
import { n as resolveIMessageInboundConversationId, t as sanitizeOutboundText } from "./sanitize-outbound-BQ1rwkeO.js";
import { n as resolveIMessageAttachmentRoots, r as resolveIMessageRemoteAttachmentRoots } from "./media-contract-CA72oN5j.js";
import { t as extractMarkdownFormatRuns } from "./markdown-format-Cqti91oT.js";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import { createHash } from "node:crypto";
//#region extensions/imessage/src/chat.ts
function buildChatTargetParams(to, opts) {
	const cfg = requireRuntimeConfig(opts.cfg, "iMessage chat action");
	const account = opts.account ?? resolveIMessageAccount({
		cfg,
		accountId: opts.accountId
	});
	const target = parseIMessageTarget(opts.chatId ? formatIMessageChatTarget(opts.chatId) : to);
	const params = {};
	if (target.kind === "chat_id") params.chat_id = target.chatId;
	else if (target.kind === "chat_guid") params.chat_guid = target.chatGuid;
	else if (target.kind === "chat_identifier") params.chat_identifier = target.chatIdentifier;
	else params.to = target.to;
	return {
		params,
		service: opts.service ?? (target.kind === "handle" ? target.service : void 0) ?? account.config.service,
		region: opts.region?.trim() || account.config.region?.trim() || "US",
		account
	};
}
async function runChatAction(method, params, opts) {
	const cfg = requireRuntimeConfig(opts.cfg, "iMessage chat action");
	const account = opts.account ?? resolveIMessageAccount({
		cfg,
		accountId: opts.accountId
	});
	const cliPath = opts.cliPath?.trim() || account.config.cliPath?.trim() || "imsg";
	const dbPath = opts.dbPath?.trim() || account.config.dbPath?.trim();
	const client = opts.client ?? await createIMessageRpcClient({
		cliPath,
		dbPath
	});
	const shouldClose = !opts.client;
	try {
		return await client.request(method, params, { timeoutMs: opts.timeoutMs });
	} finally {
		if (shouldClose) await client.stop();
	}
}
async function sendIMessageTyping(to, isTyping, opts) {
	const { params, service } = buildChatTargetParams(to, opts);
	params.typing = isTyping;
	if (service) params.service = service;
	await runChatAction("typing", params, opts);
}
async function markIMessageChatRead(to, opts) {
	const { params } = buildChatTargetParams(to, opts);
	await runChatAction("read", params, opts);
}
//#endregion
//#region extensions/imessage/src/monitor/persisted-echo-cache.ts
const PERSISTED_ECHO_TTL_MS = 720 * 60 * 1e3;
const MAX_PERSISTED_ECHO_ENTRIES = 256;
const PERSISTED_ECHO_DIR_MODE = 448;
const PERSISTED_ECHO_FILE_MODE = 384;
function resolvePersistedEchoPath() {
	return path.join(resolveStateDir(), "imessage", "sent-echoes.jsonl");
}
function clampPersistedEchoModes(filePath) {
	try {
		fs.chmodSync(path.dirname(filePath), PERSISTED_ECHO_DIR_MODE);
		fs.chmodSync(filePath, PERSISTED_ECHO_FILE_MODE);
	} catch {}
}
function normalizeText$1(text) {
	return text?.replace(/\r\n?/g, "\n").trim() || void 0;
}
function normalizeMessageId(messageId) {
	const normalized = messageId?.trim();
	if (!normalized || normalized === "ok" || normalized === "unknown") return;
	return normalized;
}
function parseEntry(line) {
	try {
		const parsed = JSON.parse(line);
		if (typeof parsed.scope !== "string" || typeof parsed.timestamp !== "number") return null;
		return {
			scope: parsed.scope,
			text: typeof parsed.text === "string" ? parsed.text : void 0,
			messageId: typeof parsed.messageId === "string" ? parsed.messageId : void 0,
			timestamp: parsed.timestamp
		};
	} catch {
		return null;
	}
}
let mirror = null;
let persistenceFailureLogged = false;
function reportFailure(scope, err) {
	if (persistenceFailureLogged) return;
	persistenceFailureLogged = true;
	logVerbose(`imessage echo-cache: ${scope} disabled after first failure: ${String(err)}`);
}
function loadMirrorIfStale() {
	const filePath = resolvePersistedEchoPath();
	let mtimeMs;
	try {
		mtimeMs = fs.statSync(filePath).mtimeMs;
	} catch (err) {
		if (err?.code !== "ENOENT") reportFailure("stat", err);
		mirror = {
			entries: [],
			mtimeMs: 0
		};
		return;
	}
	if (mirror && mirror.mtimeMs === mtimeMs) return;
	let raw;
	try {
		raw = fs.readFileSync(filePath, "utf8");
	} catch (err) {
		reportFailure("read", err);
		mirror = {
			entries: [],
			mtimeMs
		};
		return;
	}
	const cutoff = Date.now() - PERSISTED_ECHO_TTL_MS;
	mirror = {
		entries: raw.split(/\n+/).map(parseEntry).filter((entry) => Boolean(entry && entry.timestamp >= cutoff)).slice(-256),
		mtimeMs
	};
}
function readRecentEntries() {
	loadMirrorIfStale();
	return mirror?.entries ?? [];
}
const COMPACT_AT_ENTRY_COUNT = MAX_PERSISTED_ECHO_ENTRIES * 2;
function compactRecentEntries(entries) {
	const filePath = resolvePersistedEchoPath();
	try {
		fs.mkdirSync(path.dirname(filePath), {
			recursive: true,
			mode: PERSISTED_ECHO_DIR_MODE
		});
		fs.writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""), {
			encoding: "utf8",
			mode: PERSISTED_ECHO_FILE_MODE
		});
		clampPersistedEchoModes(filePath);
	} catch (err) {
		reportFailure("compact", err);
		return;
	}
	let mtimeMs = 0;
	try {
		mtimeMs = fs.statSync(filePath).mtimeMs;
	} catch {}
	mirror = {
		entries: [...entries],
		mtimeMs
	};
}
function appendEntry(entry) {
	const filePath = resolvePersistedEchoPath();
	try {
		fs.mkdirSync(path.dirname(filePath), {
			recursive: true,
			mode: PERSISTED_ECHO_DIR_MODE
		});
		fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, {
			encoding: "utf8",
			mode: PERSISTED_ECHO_FILE_MODE
		});
		clampPersistedEchoModes(filePath);
	} catch (err) {
		reportFailure("append", err);
		return;
	}
	let mtimeMs = 0;
	try {
		mtimeMs = fs.statSync(filePath).mtimeMs;
	} catch {}
	if (mirror) mirror = {
		entries: [...mirror.entries, entry],
		mtimeMs
	};
	else mirror = {
		entries: [entry],
		mtimeMs
	};
}
function rememberPersistedIMessageEcho(params) {
	const entry = {
		scope: params.scope,
		text: normalizeText$1(params.text),
		messageId: normalizeMessageId(params.messageId),
		timestamp: Date.now()
	};
	if (!entry.text && !entry.messageId) return;
	loadMirrorIfStale();
	appendEntry(entry);
	const total = mirror?.entries.length ?? 0;
	const cutoff = Date.now() - PERSISTED_ECHO_TTL_MS;
	const oldestStale = mirror?.entries[0] && mirror.entries[0].timestamp < cutoff;
	if (total > COMPACT_AT_ENTRY_COUNT || oldestStale) compactRecentEntries((mirror?.entries ?? []).filter((e) => e.timestamp >= cutoff).slice(-256));
}
function hasPersistedIMessageEcho(params) {
	const text = normalizeText$1(params.text);
	const messageId = normalizeMessageId(params.messageId);
	if (!text && !messageId) return false;
	for (const entry of readRecentEntries()) {
		if (entry.scope !== params.scope) continue;
		if (messageId && entry.messageId === messageId) return true;
		if (text && entry.text === text) return true;
	}
	return false;
}
//#endregion
//#region extensions/imessage/src/send.ts
const MAX_REPLY_TO_ID_LENGTH = 256;
function stripUnsafeReplyTagChars(value) {
	let next = "";
	for (const ch of value) {
		const code = ch.charCodeAt(0);
		if (code >= 0 && code <= 31 || code === 127 || ch === "[" || ch === "]") continue;
		next += ch;
	}
	return next;
}
function sanitizeReplyToId(rawReplyToId) {
	const trimmed = rawReplyToId?.trim();
	if (!trimmed) return;
	const sanitized = stripUnsafeReplyTagChars(trimmed).trim();
	if (!sanitized) return;
	if (sanitized.length > MAX_REPLY_TO_ID_LENGTH) return sanitized.slice(0, MAX_REPLY_TO_ID_LENGTH);
	return sanitized;
}
function resolveMessageId(result) {
	if (!result) return null;
	const raw = typeof result.messageId === "string" && result.messageId.trim() || typeof result.message_id === "string" && result.message_id.trim() || typeof result.id === "string" && result.id.trim() || typeof result.guid === "string" && result.guid.trim() || (typeof result.message_id === "number" ? String(result.message_id) : null) || (typeof result.id === "number" ? String(result.id) : null);
	return raw ? raw.trim() : null;
}
function resolveOutboundEchoText(text, mediaContentType) {
	if (text.trim()) return text;
	const kind = kindFromMime(mediaContentType ?? void 0);
	if (!kind) return;
	return kind === "image" ? "<media:image>" : `<media:${kind}>`;
}
function createIMessageSendReceipt(params) {
	const messageId = params.messageId.trim();
	const results = messageId && messageId !== "unknown" && messageId !== "ok" ? [{
		channel: "imessage",
		messageId,
		meta: { targetKind: params.target.kind }
	}] : [];
	if (results[0]) {
		if (params.target.kind === "chat_id") results[0].chatId = String(params.target.chatId);
		else if (params.target.kind === "chat_guid") results[0].conversationId = params.target.chatGuid;
		else if (params.target.kind === "chat_identifier") results[0].conversationId = params.target.chatIdentifier;
	}
	const receiptParams = {
		results,
		kind: params.kind
	};
	if (params.replyToId) receiptParams.replyToId = params.replyToId;
	return createMessageReceiptFromOutboundResults(receiptParams);
}
function resolveOutboundEchoScope(params) {
	if (params.target.kind === "chat_id") return `${params.accountId}:${formatIMessageChatTarget(params.target.chatId)}`;
	if (params.target.kind === "chat_guid") return `${params.accountId}:chat_guid:${params.target.chatGuid}`;
	if (params.target.kind === "chat_identifier") return `${params.accountId}:chat_identifier:${params.target.chatIdentifier}`;
	return `${params.accountId}:imessage:${params.target.to}`;
}
async function sendMessageIMessage(to, text, opts) {
	const cfg = requireRuntimeConfig(opts.config, "iMessage send");
	const account = opts.account ?? resolveIMessageAccount({
		cfg,
		accountId: opts.accountId
	});
	const cliPath = opts.cliPath?.trim() || account.config.cliPath?.trim() || "imsg";
	const dbPath = opts.dbPath?.trim() || account.config.dbPath?.trim();
	const target = parseIMessageTarget(opts.chatId ? formatIMessageChatTarget(opts.chatId) : to);
	const service = opts.service ?? (target.kind === "handle" ? target.service : void 0) ?? account.config.service;
	const region = opts.region?.trim() || account.config.region?.trim() || "US";
	const maxBytes = typeof opts.maxBytes === "number" ? opts.maxBytes : typeof account.config.mediaMaxMb === "number" ? account.config.mediaMaxMb * 1024 * 1024 : 16 * 1024 * 1024;
	let message = text ?? "";
	let filePath;
	let mediaContentType;
	if (opts.mediaUrl?.trim()) {
		const resolved = await (opts.resolveAttachmentImpl ?? resolveOutboundAttachmentFromUrl)(opts.mediaUrl.trim(), maxBytes, {
			localRoots: opts.mediaLocalRoots,
			readFile: opts.mediaReadFile
		});
		filePath = resolved.path;
		mediaContentType = resolved.contentType ?? void 0;
	}
	if (!message.trim() && !filePath) throw new Error("iMessage send requires text or media");
	if (message.trim()) {
		const tableMode = resolveMarkdownTableMode({
			cfg,
			channel: "imessage",
			accountId: account.accountId
		});
		message = convertMarkdownTables(message, tableMode);
	}
	message = stripInlineDirectiveTagsForDelivery(message).text;
	if (!message.trim() && !filePath) throw new Error("iMessage send requires text or media");
	const formatted = message.trim() ? extractMarkdownFormatRuns(message) : {
		text: message,
		ranges: []
	};
	message = formatted.text;
	if (!message.trim() && !filePath) throw new Error("iMessage send requires text or media");
	const echoText = resolveOutboundEchoText(message, filePath ? mediaContentType : void 0);
	const resolvedReplyToId = sanitizeReplyToId(opts.replyToId);
	const params = {
		text: message,
		service: service || "auto",
		region
	};
	if (resolvedReplyToId) params.reply_to = resolvedReplyToId;
	if (formatted.ranges.length > 0) params.formatting = formatted.ranges;
	if (filePath) params.file = filePath;
	if (target.kind === "chat_id") params.chat_id = target.chatId;
	else if (target.kind === "chat_guid") params.chat_guid = target.chatGuid;
	else if (target.kind === "chat_identifier") params.chat_identifier = target.chatIdentifier;
	else params.to = target.to;
	const client = opts.client ?? (opts.createClient ? await opts.createClient({
		cliPath,
		dbPath
	}) : await createIMessageRpcClient({
		cliPath,
		dbPath
	}));
	const shouldClose = !opts.client;
	try {
		const result = await client.request("send", params, { timeoutMs: opts.timeoutMs });
		const resolvedId = resolveMessageId(result);
		const messageId = resolvedId ?? (result?.ok ? "ok" : "unknown");
		const echoScope = resolveOutboundEchoScope({
			accountId: account.accountId,
			target
		});
		if (echoScope) rememberPersistedIMessageEcho({
			scope: echoScope,
			text: echoText,
			messageId: resolvedId ?? void 0
		});
		if (resolvedId) rememberIMessageReplyCache({
			accountId: account.accountId,
			messageId: resolvedId,
			chatGuid: target.kind === "chat_guid" ? target.chatGuid : void 0,
			chatIdentifier: target.kind === "chat_identifier" ? target.chatIdentifier : target.kind === "handle" ? `${target.service === "sms" ? "SMS" : "iMessage"};-;${target.to}` : void 0,
			chatId: target.kind === "chat_id" ? target.chatId : void 0,
			timestamp: Date.now(),
			isFromMe: true
		});
		return {
			messageId,
			sentText: message,
			...echoText ? { echoText } : {},
			receipt: createIMessageSendReceipt({
				messageId,
				target,
				kind: filePath ? "media" : "text",
				...resolvedReplyToId ? { replyToId: resolvedReplyToId } : {}
			})
		};
	} finally {
		if (shouldClose) await client.stop();
	}
}
//#endregion
//#region extensions/imessage/src/monitor/abort-handler.ts
function attachIMessageMonitorAbortHandler(params) {
	const abort = params.abortSignal;
	if (!abort) return () => {};
	const onAbort = () => {
		const subscriptionId = params.getSubscriptionId();
		if (subscriptionId) params.client.request("watch.unsubscribe", { subscription: subscriptionId }).catch(() => {});
		params.client.stop().catch(() => {});
	};
	abort.addEventListener("abort", onAbort, { once: true });
	return () => abort.removeEventListener("abort", onAbort);
}
//#endregion
//#region extensions/imessage/src/monitor/catchup.ts
const DEFAULT_MAX_AGE_MINUTES = 120;
const MAX_MAX_AGE_MINUTES = 720;
const DEFAULT_PER_RUN_LIMIT = 50;
const MAX_PER_RUN_LIMIT = 500;
const DEFAULT_FIRST_RUN_LOOKBACK_MINUTES = 30;
const DEFAULT_MAX_FAILURE_RETRIES = 10;
const MAX_MAX_FAILURE_RETRIES = 1e3;
const MAX_FAILURE_RETRY_MAP_SIZE = 5e3;
function resolveStateDirFromEnv(env = process.env) {
	if (env.OPENCLAW_STATE_DIR?.trim()) return resolveStateDir(env);
	if (env.VITEST || env.NODE_ENV === "test") {
		const name = "openclaw-vitest-" + process.pid;
		return path.join(resolvePreferredOpenClawTmpDir(), name);
	}
	return resolveStateDir(env);
}
function resolveCursorFilePath(accountId) {
	const safePrefix = accountId.replace(/[^a-zA-Z0-9_-]/g, "_") || "account";
	const hash = createHash("sha256").update(accountId, "utf8").digest("hex").slice(0, 12);
	return path.join(resolveStateDirFromEnv(), "imessage", "catchup", `${safePrefix}__${hash}.json`);
}
function sanitizeFailureRetriesInput(raw) {
	if (!raw || typeof raw !== "object") return {};
	const out = {};
	for (const [guid, count] of Object.entries(raw)) {
		if (!guid || typeof guid !== "string") continue;
		if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) continue;
		out[guid] = Math.floor(count);
	}
	return out;
}
/**
* Cursor file path: `<openclawStateDir>/imessage/catchup/<safePrefix>__<sha256[:12]>.json`.
* `openclawStateDir` resolves through `OPENCLAW_STATE_DIR` (or the plugin-sdk default,
* `~/.openclaw`). On a default install the cursor lands at
* `~/.openclaw/imessage/catchup/<safePrefix>__<sha256[:12]>.json`.
*/
async function loadIMessageCatchupCursor(accountId) {
	const { value } = await readJsonFileWithFallback(resolveCursorFilePath(accountId), null);
	if (!value || typeof value !== "object") return null;
	if (typeof value.lastSeenMs !== "number" || !Number.isFinite(value.lastSeenMs)) return null;
	if (typeof value.lastSeenRowid !== "number" || !Number.isFinite(value.lastSeenRowid)) return null;
	const failureRetries = sanitizeFailureRetriesInput(value.failureRetries);
	const hasRetries = Object.keys(failureRetries).length > 0;
	return {
		lastSeenMs: value.lastSeenMs,
		lastSeenRowid: value.lastSeenRowid,
		updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
		...hasRetries ? { failureRetries } : {}
	};
}
async function saveIMessageCatchupCursor(accountId, next) {
	const filePath = resolveCursorFilePath(accountId);
	const sanitized = sanitizeFailureRetriesInput(next.failureRetries);
	const hasRetries = Object.keys(sanitized).length > 0;
	await writeJsonFileAtomically(filePath, {
		lastSeenMs: next.lastSeenMs,
		lastSeenRowid: next.lastSeenRowid,
		updatedAt: Date.now(),
		...hasRetries ? { failureRetries: sanitized } : {}
	});
}
/**
* Bound the retry map so a pathological storm of unique failing GUIDs
* cannot grow the cursor file without limit. Keeps the `maxSize` entries
* with the highest counts (closest to give-up) when over the bound.
*/
function capFailureRetriesMap(map, maxSize = MAX_FAILURE_RETRY_MAP_SIZE) {
	const entries = Object.entries(map);
	if (entries.length <= maxSize) return map;
	entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	const capped = {};
	for (let i = 0; i < maxSize; i++) {
		const [guid, count] = entries[i];
		capped[guid] = count;
	}
	return capped;
}
function clampInt(value, min, max, fallback) {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(value)));
}
function resolveCatchupConfig(raw) {
	return {
		enabled: Boolean(raw?.enabled),
		maxAgeMinutes: clampInt(raw?.maxAgeMinutes, 1, MAX_MAX_AGE_MINUTES, DEFAULT_MAX_AGE_MINUTES),
		perRunLimit: clampInt(raw?.perRunLimit, 1, MAX_PER_RUN_LIMIT, DEFAULT_PER_RUN_LIMIT),
		firstRunLookbackMinutes: clampInt(raw?.firstRunLookbackMinutes, 1, MAX_MAX_AGE_MINUTES, DEFAULT_FIRST_RUN_LOOKBACK_MINUTES),
		maxFailureRetries: clampInt(raw?.maxFailureRetries, 1, MAX_MAX_FAILURE_RETRIES, DEFAULT_MAX_FAILURE_RETRIES)
	};
}
/**
* One catchup pass. Loads the cursor, fetches `messages.history`, replays
* each row through `dispatch`, advances the cursor on success / give-up,
* persists the cursor, returns a summary.
*
* The fetch and dispatch functions are injected so this loop is unit-testable
* without standing up an `imsg` daemon. The wiring in `monitor-provider.ts`
* passes the live `client.request("messages.history", ...)` adapter as
* `fetch` and the `evaluateIMessageInbound` + `dispatchInboundMessage`
* pipeline as `dispatch`.
*/
async function performIMessageCatchup(params) {
	const now = params.now ?? Date.now();
	const cfg = params.config;
	const cursor = await loadIMessageCatchupCursor(params.accountId);
	const lookbackMs = cursor === null ? cfg.firstRunLookbackMinutes * 6e4 : cfg.maxAgeMinutes * 6e4;
	const ageBoundMs = now - cfg.maxAgeMinutes * 6e4;
	const windowStartMs = Math.max(cursor?.lastSeenMs ?? now - lookbackMs, ageBoundMs);
	const windowEndMs = now;
	const sinceRowid = cursor?.lastSeenRowid ?? 0;
	const summary = {
		querySucceeded: false,
		fetchedCount: 0,
		replayed: 0,
		skippedFromMe: 0,
		skippedPreCursor: 0,
		skippedGivenUp: 0,
		failed: 0,
		givenUp: 0,
		cursorBefore: cursor ? {
			lastSeenMs: cursor.lastSeenMs,
			lastSeenRowid: cursor.lastSeenRowid
		} : null,
		cursorAfter: {
			lastSeenMs: cursor?.lastSeenMs ?? windowStartMs,
			lastSeenRowid: cursor?.lastSeenRowid ?? 0
		},
		windowStartMs,
		windowEndMs
	};
	let fetchResult;
	try {
		fetchResult = await params.fetch({
			sinceMs: windowStartMs,
			sinceRowid,
			limit: cfg.perRunLimit
		});
	} catch (err) {
		params.warn?.(`imessage catchup: fetch failed: ${String(err)}`);
		return summary;
	}
	if (!fetchResult.resolved) {
		params.warn?.(`imessage catchup: fetch returned unresolved result`);
		return summary;
	}
	summary.querySucceeded = true;
	summary.fetchedCount = fetchResult.rows.length;
	const rows = fetchResult.rows.toSorted((a, b) => a.rowid - b.rowid);
	const failureRetries = { ...cursor?.failureRetries };
	const cursorBeforeMs = cursor?.lastSeenMs ?? windowStartMs;
	const cursorBeforeRowid = cursor?.lastSeenRowid ?? 0;
	let highWatermarkMs = cursorBeforeMs;
	let highWatermarkRowid = cursorBeforeRowid;
	let earliestHeldFailureRow = null;
	for (const row of rows) {
		if (row.rowid <= sinceRowid) {
			summary.skippedPreCursor += 1;
			continue;
		}
		if (row.date < ageBoundMs) {
			summary.skippedPreCursor += 1;
			highWatermarkMs = Math.max(highWatermarkMs, row.date);
			highWatermarkRowid = Math.max(highWatermarkRowid, row.rowid);
			continue;
		}
		if (row.isFromMe) {
			summary.skippedFromMe += 1;
			highWatermarkMs = Math.max(highWatermarkMs, row.date);
			highWatermarkRowid = Math.max(highWatermarkRowid, row.rowid);
			continue;
		}
		const priorCount = failureRetries[row.guid] ?? 0;
		if (priorCount >= cfg.maxFailureRetries) {
			summary.skippedGivenUp += 1;
			highWatermarkMs = Math.max(highWatermarkMs, row.date);
			highWatermarkRowid = Math.max(highWatermarkRowid, row.rowid);
			continue;
		}
		let dispatched;
		try {
			dispatched = await params.dispatch(row);
		} catch (err) {
			params.warn?.(`imessage catchup: dispatch threw for guid=${row.guid}: ${String(err)}`);
			dispatched = { ok: false };
		}
		if (dispatched.ok) {
			summary.replayed += 1;
			delete failureRetries[row.guid];
			highWatermarkMs = Math.max(highWatermarkMs, row.date);
			highWatermarkRowid = Math.max(highWatermarkRowid, row.rowid);
			continue;
		}
		const nextCount = priorCount + 1;
		failureRetries[row.guid] = nextCount;
		summary.failed += 1;
		if (nextCount >= cfg.maxFailureRetries) {
			summary.givenUp += 1;
			params.warn?.(`imessage catchup: giving up on guid=${row.guid} after ${nextCount} failures; advancing cursor past it`);
			highWatermarkMs = Math.max(highWatermarkMs, row.date);
			highWatermarkRowid = Math.max(highWatermarkRowid, row.rowid);
			continue;
		}
		if (earliestHeldFailureRow === null || row.rowid < earliestHeldFailureRow.rowid) earliestHeldFailureRow = row;
	}
	if (earliestHeldFailureRow === null) {
		if (typeof fetchResult.highWatermarkMs === "number") highWatermarkMs = Math.max(highWatermarkMs, fetchResult.highWatermarkMs);
		if (typeof fetchResult.highWatermarkRowid === "number") highWatermarkRowid = Math.max(highWatermarkRowid, fetchResult.highWatermarkRowid);
	}
	let lastSeenMs;
	let lastSeenRowid;
	if (earliestHeldFailureRow !== null) {
		lastSeenMs = Math.max(cursorBeforeMs, earliestHeldFailureRow.date - 1);
		lastSeenRowid = Math.max(cursorBeforeRowid, earliestHeldFailureRow.rowid - 1);
	} else {
		lastSeenMs = highWatermarkMs;
		lastSeenRowid = highWatermarkRowid;
	}
	const capped = capFailureRetriesMap(failureRetries);
	summary.cursorAfter = {
		lastSeenMs,
		lastSeenRowid
	};
	await saveIMessageCatchupCursor(params.accountId, {
		lastSeenMs,
		lastSeenRowid,
		failureRetries: capped
	});
	if (summary.replayed > 0 || summary.failed > 0 || summary.givenUp > 0) params.log?.(`imessage catchup: replayed=${summary.replayed} skippedFromMe=${summary.skippedFromMe} skippedGivenUp=${summary.skippedGivenUp} failed=${summary.failed} givenUp=${summary.givenUp} fetchedCount=${summary.fetchedCount}`);
	return summary;
}
//#endregion
//#region extensions/imessage/src/monitor/strip-imsg-length-prefixed-text.ts
const utf8Decoder = new TextDecoder();
function readVarint(buf, start) {
	let offset = start;
	let value = 0;
	let shift = 0;
	while (offset < buf.length && shift <= 28) {
		const byte = buf[offset];
		offset += 1;
		value |= (byte & 127) << shift;
		if ((byte & 128) === 0) return {
			nextOffset: offset,
			value
		};
		shift += 7;
	}
	return null;
}
function tryStripImessageLengthPrefixedUtf8Buffer(buf) {
	const key = readVarint(buf, 0);
	if (!key || key.nextOffset >= buf.length) return null;
	if (key.value !== 10) return null;
	const length = readVarint(buf, key.nextOffset);
	if (!length || length.value === 0) return null;
	if (length.nextOffset + length.value !== buf.length) return null;
	return buf.subarray(length.nextOffset, buf.length);
}
function stripImessageLengthPrefixedUtf8Text(text) {
	if (!text) return text;
	const stripped = tryStripImessageLengthPrefixedUtf8Buffer(Buffer.from(text, "utf8"));
	if (!stripped) return text;
	const inner = utf8Decoder.decode(stripped);
	return inner.length > 0 ? inner : text;
}
//#endregion
//#region extensions/imessage/src/monitor/parse-notification.ts
function isOptionalString(value) {
	return value === void 0 || value === null || typeof value === "string";
}
function isOptionalStringOrNumber(value) {
	return value === void 0 || value === null || typeof value === "string" || typeof value === "number";
}
function isOptionalNumber(value) {
	return value === void 0 || value === null || typeof value === "number";
}
function isOptionalBoolean(value) {
	return value === void 0 || value === null || typeof value === "boolean";
}
function isOptionalStringArray(value) {
	return value === void 0 || value === null || Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
function isOptionalAttachments(value) {
	if (value === void 0 || value === null) return true;
	if (!Array.isArray(value)) return false;
	return value.every((attachment) => {
		if (!isRecord(attachment)) return false;
		return isOptionalString(attachment.original_path) && isOptionalString(attachment.mime_type) && isOptionalBoolean(attachment.missing) && isOptionalString(attachment.transfer_name) && isOptionalString(attachment.uti);
	});
}
function parseIMessageNotification(raw) {
	if (!isRecord(raw)) return null;
	const maybeMessage = raw.message;
	if (!isRecord(maybeMessage)) return null;
	const message = maybeMessage;
	if (!isOptionalNumber(message.id) || !isOptionalString(message.guid) || !isOptionalNumber(message.chat_id) || !isOptionalString(message.sender) || !isOptionalString(message.destination_caller_id) || !isOptionalBoolean(message.is_from_me) || !isOptionalString(message.text) || !isOptionalStringOrNumber(message.reply_to_id) || !isOptionalString(message.reply_to_text) || !isOptionalString(message.reply_to_sender) || !isOptionalString(message.created_at) || !isOptionalBoolean(message.is_reaction) || !isOptionalBoolean(message.is_tapback) || !isOptionalString(message.associated_message_guid) || !isOptionalNumber(message.associated_message_type) || !isOptionalString(message.reaction_type) || !isOptionalString(message.reaction_emoji) || !isOptionalBoolean(message.is_reaction_add) || !isOptionalString(message.reacted_to_guid) || !isOptionalAttachments(message.attachments) || !isOptionalString(message.chat_identifier) || !isOptionalString(message.chat_guid) || !isOptionalString(message.chat_name) || !isOptionalStringArray(message.participants) || !isOptionalBoolean(message.is_group)) return null;
	return {
		...message,
		text: typeof message.text === "string" ? stripImessageLengthPrefixedUtf8Text(message.text) : message.text,
		reply_to_text: typeof message.reply_to_text === "string" ? stripImessageLengthPrefixedUtf8Text(message.reply_to_text) : message.reply_to_text
	};
}
//#endregion
//#region extensions/imessage/src/monitor/catchup-bridge.ts
const PER_CHAT_HISTORY_LIMIT_CAP = 500;
const CATCHUP_CHATS_LIST_LIMIT = 200;
const CATCHUP_RPC_TIMEOUT_MS = 3e4;
/**
* Wire `performIMessageCatchup` against the live `imsg` JSON-RPC client.
*
* Catchup recovers messages that landed in `chat.db` while the gateway was
* offline (crash, restart, mac sleep) by:
*   1. listing recently-active chats via `chats.list`,
*   2. fetching per-chat history since the cursor via `messages.history`,
*   3. sorting cross-chat by `rowid`, capping at `perRunLimit`,
*   4. replaying each row through the same `dispatchPayload` handler used
*      by the live notification loop, so existing dedupe / coalesce / echo
*      / read-receipt behavior covers replayed rows for free.
*
* Runs at most once per `monitorIMessageProvider` invocation, between
* `watch.subscribe` and the live dispatch loop. Anything that arrives during
* catchup itself flows through live dispatch; the existing inbound-dedupe
* cache absorbs any overlap.
*/
async function runIMessageCatchup(params) {
	const { client, accountId, config, includeAttachments, dispatchPayload, runtime } = params;
	const log = (msg) => runtime?.log?.(msg);
	const warnLog = (msg) => runtime?.log?.(warn(msg));
	const payloadByGuid = /* @__PURE__ */ new Map();
	const fetchFn = async ({ sinceMs, sinceRowid, limit }) => {
		let chatsResult;
		try {
			chatsResult = await client.request("chats.list", { limit: CATCHUP_CHATS_LIST_LIMIT }, { timeoutMs: CATCHUP_RPC_TIMEOUT_MS });
		} catch (err) {
			warnLog(`imessage catchup: chats.list failed: ${String(err)}`);
			return {
				resolved: false,
				rows: []
			};
		}
		const chats = chatsResult?.chats ?? [];
		const sinceISO = new Date(sinceMs).toISOString();
		const collected = [];
		const perChatLimit = Math.min(limit, PER_CHAT_HISTORY_LIMIT_CAP);
		let rawWatermarkRowid = -Infinity;
		let rawWatermarkMs = -Infinity;
		for (const chat of chats) {
			const chatId = typeof chat.id === "number" && Number.isFinite(chat.id) ? chat.id : null;
			if (chatId === null) continue;
			const lastMs = typeof chat.last_message_at === "string" ? Date.parse(chat.last_message_at) : NaN;
			if (Number.isFinite(lastMs) && lastMs < sinceMs) continue;
			let historyResult;
			try {
				historyResult = await client.request("messages.history", {
					chat_id: chatId,
					limit: perChatLimit,
					start: sinceISO,
					attachments: includeAttachments
				}, { timeoutMs: CATCHUP_RPC_TIMEOUT_MS });
			} catch (err) {
				warnLog(`imessage catchup: messages.history failed for chat_id=${chatId}: ${String(err)}`);
				continue;
			}
			const messages = Array.isArray(historyResult?.messages) ? historyResult.messages : [];
			for (const raw of messages) {
				const rawRecord = raw && typeof raw === "object" ? raw : null;
				const rawRowid = rawRecord && typeof rawRecord.id === "number" && Number.isFinite(rawRecord.id) ? rawRecord.id : null;
				const rawCreatedAt = rawRecord && typeof rawRecord.created_at === "string" ? rawRecord.created_at : null;
				const rawDateMs = rawCreatedAt ? Date.parse(rawCreatedAt) : NaN;
				if (rawRowid !== null) rawWatermarkRowid = Math.max(rawWatermarkRowid, rawRowid);
				if (Number.isFinite(rawDateMs)) rawWatermarkMs = Math.max(rawWatermarkMs, rawDateMs);
				const payload = parseIMessageNotification({ message: raw });
				if (!payload) continue;
				const guid = payload.guid?.trim();
				const rowid = typeof payload.id === "number" ? payload.id : null;
				const dateMs = typeof payload.created_at === "string" ? Date.parse(payload.created_at) : NaN;
				if (!guid || rowid === null || !Number.isFinite(rowid) || !Number.isFinite(dateMs)) continue;
				if (rowid <= sinceRowid) continue;
				collected.push({
					guid,
					rowid,
					date: dateMs,
					isFromMe: payload.is_from_me === true
				});
				payloadByGuid.set(guid, payload);
			}
		}
		const sorted = collected.toSorted((a, b) => a.rowid - b.rowid);
		const capped = sorted.slice(0, limit);
		const isCapTruncated = capped.length < sorted.length;
		if (isCapTruncated) {
			warnLog(`imessage catchup: fetched ${sorted.length} rows across chats, capped to perRunLimit=${limit} (oldest first); next startup picks up the rest`);
			const keep = new Set(capped.map((row) => row.guid));
			for (const guid of payloadByGuid.keys()) if (!keep.has(guid)) payloadByGuid.delete(guid);
		}
		let effectiveWatermarkRowid = rawWatermarkRowid;
		let effectiveWatermarkMs = rawWatermarkMs;
		if (isCapTruncated && capped.length > 0) {
			const last = capped.at(-1);
			if (last) {
				effectiveWatermarkRowid = Math.min(effectiveWatermarkRowid, last.rowid);
				effectiveWatermarkMs = Math.min(effectiveWatermarkMs, last.date);
			}
		} else if (isCapTruncated && capped.length === 0) {
			effectiveWatermarkRowid = NaN;
			effectiveWatermarkMs = NaN;
		}
		return {
			resolved: true,
			rows: capped,
			...Number.isFinite(effectiveWatermarkRowid) ? { highWatermarkRowid: effectiveWatermarkRowid } : {},
			...Number.isFinite(effectiveWatermarkMs) ? { highWatermarkMs: effectiveWatermarkMs } : {}
		};
	};
	const dispatchFn = async (row) => {
		const payload = payloadByGuid.get(row.guid);
		if (!payload) {
			warnLog(`imessage catchup: missing payload for guid=${row.guid}, skipping`);
			return { ok: false };
		}
		try {
			await dispatchPayload(payload);
			return { ok: true };
		} catch (err) {
			warnLog(`imessage catchup: dispatch threw for guid=${row.guid}: ${String(err)}`);
			return { ok: false };
		}
	};
	return await performIMessageCatchup({
		accountId,
		config,
		fetch: fetchFn,
		dispatch: dispatchFn,
		log,
		warn: warnLog,
		...params.now ? { now: params.now() } : {}
	});
}
//#endregion
//#region extensions/imessage/src/monitor/coalesce.ts
/**
* Bounds on the merged output when multiple inbound iMessage payloads are
* folded into one agent turn. Caps each merge so a sender who
* rapid-fires DMs inside the debounce window cannot amplify the downstream
* prompt past a safe ceiling. Every source GUID still surfaces via
* `coalescedMessageGuids` so a future replay path can recognize duplicates.
*/
const MAX_COALESCED_TEXT_CHARS = 4e3;
/**
* Combine consecutive same-sender iMessage payloads into a single payload for
* downstream dispatch. Used when the debouncer flushes a bucket containing
* more than one event — e.g. Apple's split-send for `Dump https://example.com`
* arriving as two separate `chat.db` rows ~0.8-2.0 s apart.
*
* The first payload anchors the merged shape (preserving its GUID for reply
* threading). Text is concatenated with deduplication, attachments are merged
* (capped), and the latest `created_at` wins so downstream sees the most
* recent activity timestamp.
*/
function combineIMessagePayloads(payloads) {
	if (payloads.length === 0) throw new Error("combineIMessagePayloads: cannot combine empty payloads");
	if (payloads.length === 1) return payloads[0];
	const first = payloads[0];
	const last = payloads[payloads.length - 1];
	const boundedPayloads = payloads.length > 10 ? [...payloads.slice(0, 9), last] : payloads;
	const seenTexts = /* @__PURE__ */ new Set();
	const textParts = [];
	for (const payload of boundedPayloads) {
		const text = (payload.text ?? "").trim();
		if (!text) continue;
		const normalized = text.toLowerCase();
		if (seenTexts.has(normalized)) continue;
		seenTexts.add(normalized);
		textParts.push(text);
	}
	let combinedText = textParts.join(" ");
	if (combinedText.length > 4e3) combinedText = `${combinedText.slice(0, MAX_COALESCED_TEXT_CHARS)}…[truncated]`;
	const allAttachments = boundedPayloads.flatMap((p) => p.attachments ?? []).slice(0, 20);
	const createdAts = payloads.map((p) => p.created_at).filter((c) => typeof c === "string" && c.length > 0);
	const latestCreatedAt = createdAts.length > 0 ? createdAts.reduce((a, b) => a > b ? a : b) : first.created_at;
	const seenGuids = /* @__PURE__ */ new Set();
	const coalescedMessageGuids = [];
	for (const payload of payloads) {
		const guid = payload.guid?.trim();
		if (!guid || seenGuids.has(guid)) continue;
		seenGuids.add(guid);
		coalescedMessageGuids.push(guid);
	}
	const entryWithReply = payloads.find((p) => p.reply_to_id != null);
	return {
		...first,
		text: combinedText,
		attachments: allAttachments.length > 0 ? allAttachments : null,
		created_at: latestCreatedAt,
		reply_to_id: entryWithReply?.reply_to_id ?? first.reply_to_id ?? null,
		reply_to_text: entryWithReply?.reply_to_text ?? first.reply_to_text ?? null,
		reply_to_sender: entryWithReply?.reply_to_sender ?? first.reply_to_sender ?? null,
		coalescedMessageGuids: coalescedMessageGuids.length > 0 ? coalescedMessageGuids : void 0
	};
}
//#endregion
//#region extensions/imessage/src/monitor/deliver.ts
async function deliverReplies(params) {
	const { replies, target, client, runtime, maxBytes, textLimit, accountId, sentMessageCache } = params;
	const scope = `${accountId ?? ""}:${target}`;
	const { cfg } = params;
	const tableMode = resolveMarkdownTableMode({
		cfg,
		channel: "imessage",
		accountId
	});
	const chunkMode = resolveChunkMode(cfg, "imessage", accountId);
	for (const payload of replies) if (await deliverTextOrMediaReply({
		payload,
		text: resolveSendableOutboundReplyParts(payload, { text: convertMarkdownTables(sanitizeOutboundText(payload.text ?? ""), tableMode) }).text,
		chunkText: (value) => chunkTextWithMode(value, textLimit, chunkMode),
		sendText: async (chunk) => {
			const sent = await sendMessageIMessage(target, chunk, {
				config: params.cfg,
				maxBytes,
				client,
				accountId,
				replyToId: payload.replyToId
			});
			sentMessageCache?.remember(scope, {
				text: sent.echoText ?? sent.sentText,
				messageId: sent.messageId
			});
		},
		sendMedia: async ({ mediaUrl, caption }) => {
			const sent = await sendMessageIMessage(target, caption ?? "", {
				config: params.cfg,
				mediaUrl,
				maxBytes,
				client,
				accountId,
				replyToId: payload.replyToId
			});
			sentMessageCache?.remember(scope, {
				text: sent.echoText ?? (sent.sentText || void 0),
				messageId: sent.messageId
			});
		}
	}) !== "empty") runtime.log?.(`imessage: delivered reply to ${target}`);
}
function createIMessageEchoCachingSend(params) {
	return async (target, text, opts) => {
		const sent = await sendMessageIMessage(target, sanitizeOutboundText(text), {
			...opts,
			client: params.client
		});
		const scope = `${params.accountId ?? opts.accountId ?? ""}:${target}`;
		params.sentMessageCache?.remember(scope, {
			text: sent.echoText ?? (sent.sentText || void 0),
			messageId: sent.messageId
		});
		return sent;
	};
}
//#endregion
//#region extensions/imessage/src/monitor/echo-cache.ts
const SENT_MESSAGE_TEXT_TTL_MS = 4e3;
const SENT_MESSAGE_ID_TTL_MS = 6e4;
const LEADING_ATTRIBUTED_BODY_CORRUPTION_MARKERS = /^[\uFEFF\uFFFD\uFFFE\uFFFF]+/u;
function normalizeEchoTextKey(text) {
	if (!text) return null;
	const normalized = text.replace(/\r\n?/g, "\n").trim().replace(LEADING_ATTRIBUTED_BODY_CORRUPTION_MARKERS, "").trim();
	return normalized ? normalized : null;
}
function normalizeEchoMessageIdKey(messageId) {
	if (!messageId) return null;
	const normalized = messageId.trim();
	if (!normalized || normalized === "ok" || normalized === "unknown") return null;
	return normalized;
}
var DefaultSentMessageCache = class {
	constructor() {
		this.textCache = /* @__PURE__ */ new Map();
		this.textBackedByIdCache = /* @__PURE__ */ new Map();
		this.messageIdCache = /* @__PURE__ */ new Map();
	}
	remember(scope, lookup) {
		const textKey = normalizeEchoTextKey(lookup.text);
		if (textKey) this.textCache.set(`${scope}:${textKey}`, Date.now());
		const messageIdKey = normalizeEchoMessageIdKey(lookup.messageId);
		if (messageIdKey) {
			this.messageIdCache.set(`${scope}:${messageIdKey}`, Date.now());
			if (textKey) this.textBackedByIdCache.set(`${scope}:${textKey}`, Date.now());
		}
		this.cleanup();
	}
	has(scope, lookup, skipIdShortCircuit = false) {
		this.cleanup();
		if (hasPersistedIMessageEcho({
			scope,
			...lookup
		})) return true;
		const textKey = normalizeEchoTextKey(lookup.text);
		const messageIdKey = normalizeEchoMessageIdKey(lookup.messageId);
		if (messageIdKey) {
			const idTimestamp = this.messageIdCache.get(`${scope}:${messageIdKey}`);
			if (idTimestamp && Date.now() - idTimestamp <= SENT_MESSAGE_ID_TTL_MS) return true;
			const textTimestamp = textKey ? this.textCache.get(`${scope}:${textKey}`) : void 0;
			const textBackedByIdTimestamp = textKey ? this.textBackedByIdCache.get(`${scope}:${textKey}`) : void 0;
			if (!skipIdShortCircuit && !(typeof textTimestamp === "number" && (!textBackedByIdTimestamp || textTimestamp > textBackedByIdTimestamp))) return false;
		}
		if (textKey) {
			const textTimestamp = this.textCache.get(`${scope}:${textKey}`);
			if (textTimestamp && Date.now() - textTimestamp <= SENT_MESSAGE_TEXT_TTL_MS) return true;
		}
		return false;
	}
	cleanup() {
		const now = Date.now();
		for (const [key, timestamp] of this.textCache.entries()) if (now - timestamp > SENT_MESSAGE_TEXT_TTL_MS) this.textCache.delete(key);
		for (const [key, timestamp] of this.textBackedByIdCache.entries()) if (now - timestamp > SENT_MESSAGE_TEXT_TTL_MS) this.textBackedByIdCache.delete(key);
		for (const [key, timestamp] of this.messageIdCache.entries()) if (now - timestamp > SENT_MESSAGE_ID_TTL_MS) this.messageIdCache.delete(key);
	}
};
function createSentMessageCache() {
	return new DefaultSentMessageCache();
}
//#endregion
//#region extensions/imessage/src/monitor/group-allowlist-warnings.ts
const startupWarned = /* @__PURE__ */ new Set();
const perChatWarned = /* @__PURE__ */ new Set();
/**
* Fires once per `accountId` at monitor startup when `groupPolicy === "allowlist"`
* but `channels.imessage.groups` is empty (no `"*"` wildcard, no explicit
* `chat_id` entries). Without one of those, every group message is dropped at
* the second gate even when the sender passes `groupAllowFrom`.
*/
function warnGroupAllowlistMisconfigOnce(params) {
	if (params.groupPolicy !== "allowlist") return false;
	if ((params.groups ? Object.keys(params.groups) : []).length > 0) return false;
	const key = `imessage:${params.accountId}`;
	if (startupWarned.has(key)) return false;
	startupWarned.add(key);
	params.log(`imessage: groupPolicy="allowlist" but channels.imessage.groups is empty for account "${params.accountId}". Every inbound group message will be dropped. Add channels.imessage.groups["*"] = { requireMention: true } to allow all groups, or explicit per-chat_id entries to allow specific groups.`);
	return true;
}
/**
* Fires once per `accountId:chat_id` when the runtime allowlist gate drops a
* group message because that chat_id is not in `channels.imessage.groups`.
* Bounded by the number of distinct group chats the gateway sees.
*/
function warnGroupAllowlistDropPerChatOnce(params) {
	const chat = params.chatId == null ? "" : String(params.chatId).trim();
	if (!chat) return false;
	const key = `imessage:${params.accountId}:${chat}`;
	if (perChatWarned.has(key)) return false;
	perChatWarned.add(key);
	params.log(`imessage: dropping group message from chat_id=${chat} (account "${params.accountId}") — not in channels.imessage.groups allowlist. Add channels.imessage.groups["${chat}"] or channels.imessage.groups["*"] to allow it.`);
	return true;
}
//#endregion
//#region extensions/imessage/src/conversation-route.ts
function resolveIMessageConversationRoute(params) {
	let route = resolveAgentRoute({
		cfg: params.cfg,
		channel: "imessage",
		accountId: params.accountId,
		peer: {
			kind: params.isGroup ? "group" : "direct",
			id: params.peerId
		}
	});
	const conversationId = resolveIMessageInboundConversationId({
		isGroup: params.isGroup,
		sender: params.sender,
		chatId: params.chatId
	});
	if (!conversationId) return route;
	route = resolveConfiguredBindingRoute({
		cfg: params.cfg,
		route,
		conversation: {
			channel: "imessage",
			accountId: params.accountId,
			conversationId
		}
	}).route;
	const runtimeRoute = resolveRuntimeConversationBindingRoute({
		route,
		conversation: {
			channel: "imessage",
			accountId: params.accountId,
			conversationId
		}
	});
	route = runtimeRoute.route;
	if (runtimeRoute.bindingRecord && !runtimeRoute.boundSessionKey) logVerbose(`imessage: plugin-bound conversation ${conversationId}`);
	else if (runtimeRoute.boundSessionKey) logVerbose(`imessage: routed via bound conversation ${conversationId} -> ${runtimeRoute.boundSessionKey}`);
	return route;
}
//#endregion
//#region extensions/imessage/src/monitor/reflection-guard.ts
const REFLECTION_PATTERNS = [
	{
		re: /(?:#\+){2,}#?/,
		label: "internal-separator"
	},
	{
		re: /\bassistant\s+to\s*=\s*\w+/i,
		label: "assistant-role-marker"
	},
	{
		re: /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>/i,
		label: "thinking-tag"
	},
	{
		re: /<\s*\/?\s*relevant[-_]memories\b[^<>]*>/i,
		label: "relevant-memories-tag"
	},
	{
		re: /<\s*\/?\s*final\b[^<>]*>/i,
		label: "final-tag"
	},
	{
		re: /\bACP error\s*\(\s*ACP_[A-Z0-9_]+\s*\):/i,
		label: "acp-error"
	},
	{
		re: /\bMissing API key for\b.+\bon the gateway\b/i,
		label: "gateway-missing-api-key"
	}
];
function hasMatchOutsideCode(text, re) {
	const codeRegions = findCodeRegions(text);
	const globalRe = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
	for (const match of text.matchAll(globalRe)) {
		const start = match.index ?? -1;
		if (start >= 0 && !isInsideCode(start, codeRegions)) return true;
	}
	return false;
}
/**
* Check whether an inbound message appears to be a reflection of
* assistant-originated content. Returns matched pattern labels for telemetry.
*/
function detectReflectedContent(text) {
	if (!text) return {
		isReflection: false,
		matchedLabels: []
	};
	const matchedLabels = [];
	for (const { re, label } of REFLECTION_PATTERNS) if (hasMatchOutsideCode(text, re)) matchedLabels.push(label);
	return {
		isReflection: matchedLabels.length > 0,
		matchedLabels
	};
}
//#endregion
//#region extensions/imessage/src/monitor/inbound-processing.ts
const TAPBACK_TEXT_PATTERNS = [
	{
		prefix: "loved",
		action: "added",
		emoji: "❤️"
	},
	{
		prefix: "liked",
		action: "added",
		emoji: "👍"
	},
	{
		prefix: "disliked",
		action: "added",
		emoji: "👎"
	},
	{
		prefix: "laughed at",
		action: "added",
		emoji: "😂"
	},
	{
		prefix: "emphasized",
		action: "added",
		emoji: "‼️"
	},
	{
		prefix: "questioned",
		action: "added",
		emoji: "❓"
	},
	{
		prefix: "removed a heart from",
		action: "removed",
		emoji: "❤️"
	},
	{
		prefix: "removed a like from",
		action: "removed",
		emoji: "👍"
	},
	{
		prefix: "removed a dislike from",
		action: "removed",
		emoji: "👎"
	},
	{
		prefix: "removed a laugh from",
		action: "removed",
		emoji: "😂"
	},
	{
		prefix: "removed an emphasis from",
		action: "removed",
		emoji: "‼️"
	},
	{
		prefix: "removed a question from",
		action: "removed",
		emoji: "❓"
	}
];
function normalizeReactionValue(value) {
	return typeof value === "string" ? value.trim().replace(/^p:\d+\//iu, "") || void 0 : void 0;
}
function resolveReactionTargetGuidCandidates(...values) {
	const candidates = [];
	for (const value of values) {
		if (typeof value !== "string") continue;
		const raw = value.trim();
		if (!raw) continue;
		const normalized = raw.replace(/^p:\d+\//iu, "");
		for (const candidate of [normalized, raw]) if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
	}
	return candidates;
}
function resolveTapbackTextContext(bodyText) {
	const lower = bodyText.toLowerCase();
	for (const pattern of TAPBACK_TEXT_PATTERNS) {
		if (!lower.startsWith(pattern.prefix)) continue;
		const afterPrefix = bodyText.slice(pattern.prefix.length).trim();
		if (!/^["\u201c]/u.test(afterPrefix)) continue;
		return {
			action: pattern.action,
			emoji: pattern.emoji,
			targetText: afterPrefix.replace(/^["\u201c]/u, "").replace(/["\u201d]$/u, "").trim()
		};
	}
	return null;
}
function resolveIMessageReactionContext(message, bodyText) {
	if (message.is_reaction === true || message.is_tapback === true || typeof message.associated_message_type === "number" && Number.isFinite(message.associated_message_type) && message.associated_message_type >= 2e3 && message.associated_message_type < 4e3) {
		const targetGuids = resolveReactionTargetGuidCandidates(message.reacted_to_guid, message.associated_message_guid);
		return {
			action: message.is_reaction_add === false ? "removed" : "added",
			emoji: normalizeReactionValue(message.reaction_emoji) ?? normalizeReactionValue(message.reaction_type) ?? "reaction",
			targetGuid: targetGuids[0],
			targetGuids
		};
	}
	return resolveTapbackTextContext(bodyText);
}
const normalizeNonEmpty = (value) => value.trim() || null;
const imessageConversationIdentityKinds = new Set([
	"plugin:imessage-chat-id",
	"plugin:imessage-chat-guid",
	"plugin:imessage-chat-identifier"
]);
const matchIMessageIngressEntry = ({ entry, context }) => {
	if (imessageConversationIdentityKinds.has(entry.kind) && context !== "group") return false;
};
function isIMessageConversationAllowTarget(entry) {
	const parsed = parseIMessageAllowTarget(entry);
	return parsed.kind === "chat_id" || parsed.kind === "chat_guid" || parsed.kind === "chat_identifier";
}
function mergeIMessageGroupAllowFromWithLegacyChatTargets(params) {
	if (params.groupAllowFrom.length > 0 || !params.allowLegacyConversationTargets) return params.groupAllowFrom;
	const legacyChatTargets = params.allowFrom.filter((entry) => isIMessageConversationAllowTarget(entry));
	if (legacyChatTargets.length === 0) return params.groupAllowFrom;
	return Array.from(new Set([...params.groupAllowFrom, ...legacyChatTargets]));
}
const imessageIngressIdentity = defineStableChannelIngressIdentity({
	key: "imessage-sender",
	normalizeEntry: normalizeIMessageHandleEntry,
	normalizeSubject: normalizeIMessageHandle,
	sensitivity: "pii",
	matchEntry: matchIMessageIngressEntry,
	aliases: [
		[
			"imessage-chat-id",
			"plugin:imessage-chat-id",
			normalizeIMessageChatIdEntry
		],
		[
			"imessage-chat-guid",
			"plugin:imessage-chat-guid",
			normalizeIMessageChatGuidEntry
		],
		[
			"imessage-chat-identifier",
			"plugin:imessage-chat-identifier",
			normalizeIMessageChatIdentifierEntry
		]
	].map(([key, kind, normalizeEntry]) => ({
		key,
		kind,
		normalizeEntry,
		normalizeSubject: normalizeNonEmpty,
		sensitivity: "pii"
	})),
	resolveEntryId: ({ entryIndex }) => `imessage-entry-${entryIndex + 1}`
});
function normalizeIMessageHandleEntry(entry) {
	const parsed = parseIMessageAllowTarget(entry.trim());
	return parsed.kind === "handle" ? normalizeIMessageHandle(parsed.handle) : null;
}
function normalizeIMessageChatIdEntry(entry) {
	const parsed = parseIMessageAllowTarget(entry.trim());
	return parsed.kind === "chat_id" ? String(parsed.chatId) : null;
}
function normalizeIMessageChatGuidEntry(entry) {
	const parsed = parseIMessageAllowTarget(entry.trim());
	return parsed.kind === "chat_guid" ? parsed.chatGuid.trim() || null : null;
}
function normalizeIMessageChatIdentifierEntry(entry) {
	const parsed = parseIMessageAllowTarget(entry.trim());
	return parsed.kind === "chat_identifier" ? parsed.chatIdentifier.trim() || null : null;
}
function normalizeDmPolicy(policy) {
	return policy === "open" || policy === "allowlist" || policy === "disabled" ? policy : "pairing";
}
function normalizeGroupPolicy(policy) {
	return policy === "open" || policy === "disabled" ? policy : "allowlist";
}
function normalizeReplyField(value) {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed ? trimmed : void 0;
	}
	if (typeof value === "number") return String(value);
}
function describeReplyContext(message) {
	const body = normalizeReplyField(message.reply_to_text);
	if (!body) return null;
	return {
		body,
		id: normalizeReplyField(message.reply_to_id),
		sender: normalizeReplyField(message.reply_to_sender)
	};
}
function resolveInboundEchoMessageIds(message) {
	const values = [message.id != null ? String(message.id) : void 0, normalizeReplyField(message.guid)];
	const ids = [];
	for (const value of values) {
		if (!value || ids.includes(value)) continue;
		ids.push(value);
	}
	return ids;
}
function hasIMessageEchoMatch(params) {
	const scopes = typeof params.scope === "string" ? [params.scope] : params.scope;
	for (const scope of scopes) {
		if (!scope) continue;
		for (const messageId of params.messageIds) if (params.echoCache.has(scope, { messageId })) return true;
		const fallbackMessageId = params.messageIds[0];
		if (!params.text && !fallbackMessageId) continue;
		if (params.echoCache.has(scope, {
			text: params.text,
			messageId: fallbackMessageId
		}, params.skipIdShortCircuit)) return true;
	}
	return false;
}
function isKnownFromMeIMessageReactionTarget(params) {
	const { messageId, accountId, chatId, chatGuid, chatIdentifier } = params;
	const ctx = {
		accountId,
		chatId,
		chatGuid,
		chatIdentifier
	};
	if (params.isKnownFromMeMessageId) return params.isKnownFromMeMessageId(messageId, ctx);
	return isKnownFromMeIMessageMessageId(messageId, ctx);
}
/**
* Per-group `systemPrompt` resolution. Mirrors `resolveWhatsAppGroupSystemPrompt`
* in `extensions/whatsapp/src/system-prompt.ts`:
*
* 1. If the matched per-`chat_id` entry exists AND defines `systemPrompt` (key
*    is present, value is non-null), use it. Trim whitespace; if the trim
*    leaves an empty string, return `undefined` and DO NOT fall through to the
*    wildcard. This is how operators say "this specific group has no prompt"
*    without inheriting from `groups["*"]`.
* 2. Otherwise, return the wildcard `groups["*"].systemPrompt` (trimmed; empty
*    after trim → `undefined`).
*/
function resolveIMessageGroupSystemPrompt(params) {
	const specific = params.groupConfig;
	if (specific != null && specific.systemPrompt != null) return specific.systemPrompt.trim() || void 0;
	const wildcard = params.defaultConfig?.systemPrompt;
	return wildcard != null ? wildcard.trim() || void 0 : void 0;
}
async function resolveIMessageInboundDecision(params) {
	const sender = (params.message.sender ?? "").trim();
	if (!sender) return {
		kind: "drop",
		reason: "missing sender"
	};
	const senderNormalized = normalizeIMessageHandle(sender);
	const chatId = params.message.chat_id ?? void 0;
	const chatGuid = params.message.chat_guid ?? void 0;
	const chatIdentifier = params.message.chat_identifier ?? void 0;
	const destinationCallerId = params.message.destination_caller_id ?? void 0;
	const createdAt = params.message.created_at ? Date.parse(params.message.created_at) : void 0;
	const messageText = params.messageText.trim();
	const bodyText = params.bodyText.trim();
	const reactionContext = resolveIMessageReactionContext(params.message, bodyText || messageText);
	const groupIdCandidate = chatId !== void 0 ? String(chatId) : void 0;
	const groupAllowFromWithLegacyChatTargets = mergeIMessageGroupAllowFromWithLegacyChatTargets({
		groupAllowFrom: params.groupAllowFrom,
		allowFrom: params.allowFrom,
		allowLegacyConversationTargets: params.allowLegacyConversationAllowFromForGroup
	});
	const groupListPolicy = groupIdCandidate ? resolveChannelGroupPolicy({
		cfg: params.cfg,
		channel: "imessage",
		accountId: params.accountId,
		groupId: groupIdCandidate,
		hasGroupAllowFrom: groupAllowFromWithLegacyChatTargets.length > 0
	}) : {
		allowlistEnabled: false,
		allowed: true,
		groupConfig: void 0,
		defaultConfig: void 0
	};
	const treatAsGroupByConfig = Boolean(groupIdCandidate && groupListPolicy.allowlistEnabled && groupListPolicy.groupConfig);
	const isGroup = Boolean(params.message.is_group) || treatAsGroupByConfig;
	const selfChatLookup = {
		accountId: params.accountId,
		isGroup,
		chatId,
		sender,
		text: bodyText,
		createdAt
	};
	const chatIdentifierNormalized = normalizeIMessageHandle(chatIdentifier ?? "") || void 0;
	const destinationCallerIdNormalized = normalizeIMessageHandle(destinationCallerId ?? "") || void 0;
	const isSelfChat = !isGroup && chatIdentifierNormalized != null && senderNormalized === chatIdentifierNormalized && destinationCallerIdNormalized != null && destinationCallerIdNormalized === senderNormalized;
	const isAmbiguousSelfThread = !isGroup && chatIdentifierNormalized != null && senderNormalized === chatIdentifierNormalized && destinationCallerIdNormalized == null;
	let skipSelfChatHasCheck = false;
	const inboundMessageIds = resolveInboundEchoMessageIds(params.message);
	const inboundMessageId = inboundMessageIds[0];
	const hasInboundGuid = Boolean(normalizeReplyField(params.message.guid));
	if (params.message.is_from_me) {
		if (isAmbiguousSelfThread) params.selfChatCache?.remember(selfChatLookup);
		if (isSelfChat) {
			params.selfChatCache?.remember(selfChatLookup);
			const echoScope = buildIMessageEchoScope({
				accountId: params.accountId,
				isGroup,
				chatId,
				chatGuid,
				chatIdentifier,
				sender
			});
			if (params.echoCache && (bodyText || inboundMessageId) && hasIMessageEchoMatch({
				echoCache: params.echoCache,
				scope: echoScope,
				text: bodyText || void 0,
				messageIds: inboundMessageIds,
				skipIdShortCircuit: !hasInboundGuid
			})) return {
				kind: "drop",
				reason: "agent echo in self-chat"
			};
			skipSelfChatHasCheck = true;
		} else return {
			kind: "drop",
			reason: "from me"
		};
	}
	if (isGroup && !chatId) return {
		kind: "drop",
		reason: "group without chat_id"
	};
	const groupId = isGroup ? groupIdCandidate : void 0;
	const hasControlCommandInMessage = hasControlCommand(messageText, params.cfg);
	const groupAllowFromForAccess = isGroup ? groupAllowFromWithLegacyChatTargets : params.groupAllowFrom;
	const { commandAccess, senderAccess } = await createChannelIngressResolver({
		channelId: "imessage",
		accountId: params.accountId,
		identity: imessageIngressIdentity,
		cfg: params.cfg,
		readStoreAllowFrom: async () => params.storeAllowFrom
	}).message({
		subject: {
			stableId: sender,
			aliases: {
				...chatId != null ? { "imessage-chat-id": String(chatId) } : {},
				...chatGuid ? { "imessage-chat-guid": chatGuid } : {},
				...chatIdentifier ? { "imessage-chat-identifier": chatIdentifier } : {}
			}
		},
		conversation: {
			kind: isGroup ? "group" : "direct",
			id: isGroup ? String(chatId ?? chatGuid ?? chatIdentifier ?? "unknown") : normalizeIMessageHandle(sender)
		},
		dmPolicy: normalizeDmPolicy(params.dmPolicy),
		groupPolicy: normalizeGroupPolicy(params.groupPolicy),
		policy: { groupAllowFromFallbackToAllowFrom: false },
		allowFrom: params.allowFrom,
		groupAllowFrom: groupAllowFromForAccess,
		command: {
			allowTextCommands: isGroup,
			hasControlCommand: hasControlCommandInMessage,
			directGroupAllowFrom: "effective"
		}
	});
	const effectiveGroupAllowFrom = senderAccess.effectiveGroupAllowFrom;
	if (senderAccess.decision !== "allow") {
		if (isGroup) {
			if (senderAccess.reasonCode === "group_policy_disabled") {
				params.logVerbose?.("Blocked iMessage group message (groupPolicy: disabled)");
				return {
					kind: "drop",
					reason: "groupPolicy disabled"
				};
			}
			if (senderAccess.reasonCode === "group_policy_empty_allowlist") {
				params.logVerbose?.("Blocked iMessage group message (groupPolicy: allowlist, no groupAllowFrom)");
				return {
					kind: "drop",
					reason: "groupPolicy allowlist (empty groupAllowFrom)"
				};
			}
			if (senderAccess.reasonCode === "group_policy_not_allowlisted") {
				params.logVerbose?.(`Blocked iMessage sender ${sender} (not in groupAllowFrom)`);
				return {
					kind: "drop",
					reason: "not in groupAllowFrom"
				};
			}
			params.logVerbose?.(`Blocked iMessage group message (${senderAccess.reasonCode})`);
			return {
				kind: "drop",
				reason: senderAccess.reasonCode
			};
		}
		if (senderAccess.reasonCode === "dm_policy_disabled") return {
			kind: "drop",
			reason: "dmPolicy disabled"
		};
		if (senderAccess.decision === "pairing") return {
			kind: "pairing",
			senderId: senderNormalized
		};
		params.logVerbose?.(`Blocked iMessage sender ${sender} (dmPolicy=${params.dmPolicy})`);
		return {
			kind: "drop",
			reason: "dmPolicy blocked"
		};
	}
	if (isGroup && groupListPolicy.allowlistEnabled && !groupListPolicy.allowed) {
		params.logVerbose?.(`imessage: skipping group message (${groupId ?? "unknown"}) not in allowlist`);
		return {
			kind: "drop",
			reason: "group id not in allowlist"
		};
	}
	const route = resolveIMessageConversationRoute({
		cfg: params.cfg,
		accountId: params.accountId,
		isGroup,
		peerId: isGroup ? String(chatId ?? "unknown") : senderNormalized,
		sender,
		chatId
	});
	if (reactionContext) {
		const notificationMode = params.reactionNotifications ?? "own";
		if (notificationMode === "off") return {
			kind: "drop",
			reason: "reaction notifications disabled"
		};
		const targetGuid = reactionContext.targetGuid;
		const targetGuids = reactionContext.targetGuids ?? (targetGuid ? [targetGuid] : []);
		const targetIsOwn = Boolean(targetGuid && (params.echoCache && hasIMessageEchoMatch({
			echoCache: params.echoCache,
			scope: buildIMessageEchoScope({
				accountId: params.accountId,
				isGroup,
				chatId,
				chatGuid,
				chatIdentifier,
				sender
			}),
			messageIds: targetGuids
		}) || targetGuids.some((messageId) => isKnownFromMeIMessageReactionTarget({
			messageId,
			accountId: params.accountId,
			chatId,
			chatGuid,
			chatIdentifier,
			isKnownFromMeMessageId: params.isKnownFromMeMessageId
		}))));
		if (notificationMode === "own" && !targetIsOwn) return {
			kind: "drop",
			reason: "reaction target not sent by agent"
		};
		const target = targetGuid ? `msg ${targetGuid}` : reactionContext.targetText ? `message "${truncateUtf16Safe(reactionContext.targetText, 80)}"` : "a message";
		return {
			kind: "reaction",
			isGroup,
			chatId,
			chatGuid,
			chatIdentifier,
			sender,
			senderNormalized,
			route,
			reaction: reactionContext,
			text: `iMessage reaction ${reactionContext.action}: ${reactionContext.emoji} by ${senderNormalized} on ${target}`,
			contextKey: [
				"imessage",
				"reaction",
				reactionContext.action,
				chatId ?? chatGuid ?? chatIdentifier ?? senderNormalized,
				targetGuid ?? reactionContext.targetText ?? "unknown",
				senderNormalized,
				reactionContext.emoji
			].join(":")
		};
	}
	const mentionRegexes = buildMentionRegexes(params.cfg, route.agentId);
	if (!bodyText) return {
		kind: "drop",
		reason: "empty body"
	};
	if (skipSelfChatHasCheck ? false : params.selfChatCache?.has({
		...selfChatLookup,
		text: bodyText
	})) {
		const preview = sanitizeTerminalText(truncateUtf16Safe(bodyText, 50));
		params.logVerbose?.(`imessage: dropping self-chat reflected duplicate: "${preview}"`);
		return {
			kind: "drop",
			reason: "self-chat echo"
		};
	}
	if (params.echoCache && (messageText || inboundMessageId)) {
		const echoScope = buildIMessageEchoScope({
			accountId: params.accountId,
			isGroup,
			chatId,
			chatGuid,
			chatIdentifier,
			sender
		});
		if (hasIMessageEchoMatch({
			echoCache: params.echoCache,
			scope: echoScope,
			text: bodyText || void 0,
			messageIds: inboundMessageIds
		})) {
			params.logVerbose?.(describeIMessageEchoDropLog({
				messageText: bodyText,
				messageId: inboundMessageId
			}));
			return {
				kind: "drop",
				reason: "echo"
			};
		}
	}
	const reflection = detectReflectedContent(messageText);
	if (reflection.isReflection) {
		params.logVerbose?.(`imessage: dropping reflected assistant content (markers: ${reflection.matchedLabels.join(", ")})`);
		return {
			kind: "drop",
			reason: "reflected assistant content"
		};
	}
	const replyContext = describeReplyContext(params.message);
	const contextVisibilityMode = resolveChannelContextVisibilityMode({
		cfg: params.cfg,
		channel: "imessage",
		accountId: params.accountId
	});
	const replyContextAllowFrom = Array.from(new Set([...groupAllowFromForAccess, ...effectiveGroupAllowFrom]));
	const replySenderAllowed = !isGroup || replyContextAllowFrom.length === 0 ? true : replyContext?.sender ? isAllowedIMessageReplyContextSender({
		allowFrom: replyContextAllowFrom,
		sender: replyContext.sender,
		chatId,
		chatGuid,
		chatIdentifier
	}) : false;
	const filteredReplyContext = !replyContext || evaluateSupplementalContextVisibility({
		mode: contextVisibilityMode,
		kind: "quote",
		senderAllowed: replySenderAllowed
	}).include ? replyContext : null;
	if (replyContext && !filteredReplyContext && isGroup) params.logVerbose?.(`imessage: drop reply context (mode=${contextVisibilityMode}, sender_allowed=${replySenderAllowed ? "yes" : "no"})`);
	const historyKey = isGroup ? String(chatId ?? chatGuid ?? chatIdentifier ?? "unknown") : void 0;
	const mentioned = isGroup ? matchesMentionPatterns(messageText, mentionRegexes) : true;
	const requireMention = resolveChannelGroupRequireMention({
		cfg: params.cfg,
		channel: "imessage",
		accountId: params.accountId,
		groupId,
		requireMentionOverride: params.opts?.requireMention,
		overrideOrder: "before-config"
	});
	const canDetectMention = mentionRegexes.length > 0;
	const commandAuthorized = commandAccess.authorized;
	if (commandAccess.shouldBlockControlCommand) {
		if (params.logVerbose) logInboundDrop({
			log: params.logVerbose,
			channel: "imessage",
			reason: "control command (unauthorized)",
			target: sender
		});
		return {
			kind: "drop",
			reason: "control command (unauthorized)"
		};
	}
	const mentionDecision = resolveInboundMentionDecision({
		facts: {
			canDetectMention,
			wasMentioned: mentioned,
			hasAnyMention: false,
			implicitMentionKinds: []
		},
		policy: {
			isGroup,
			requireMention,
			allowTextCommands: true,
			hasControlCommand: hasControlCommandInMessage,
			commandAuthorized
		}
	});
	const effectiveWasMentioned = mentionDecision.effectiveWasMentioned;
	if (isGroup && requireMention && canDetectMention && mentionDecision.shouldSkip) {
		params.logVerbose?.(`imessage: skipping group message (no mention)`);
		createChannelHistoryWindow({ historyMap: params.groupHistories }).record({
			historyKey: historyKey ?? "",
			limit: params.historyLimit,
			entry: historyKey ? {
				sender: senderNormalized,
				body: bodyText,
				timestamp: createdAt,
				messageId: params.message.id ? String(params.message.id) : void 0
			} : null
		});
		return {
			kind: "drop",
			reason: "no mention"
		};
	}
	return {
		kind: "dispatch",
		isGroup,
		chatId,
		chatGuid,
		chatIdentifier,
		groupId,
		historyKey,
		sender,
		senderNormalized,
		route,
		bodyText,
		createdAt,
		replyContext: filteredReplyContext,
		effectiveWasMentioned,
		commandAuthorized,
		groupSystemPrompt: isGroup ? resolveIMessageGroupSystemPrompt({
			groupConfig: groupListPolicy.groupConfig,
			defaultConfig: groupListPolicy.defaultConfig
		}) : void 0
	};
}
function buildIMessageInboundContext(params) {
	const envelopeOptions = params.envelopeOptions ?? resolveEnvelopeFormatOptions(params.cfg);
	const { decision } = params;
	const chatId = decision.chatId;
	const chatTarget = decision.isGroup && chatId != null ? formatIMessageChatTarget(chatId) : void 0;
	const messageGuid = normalizeReplyField(params.message.guid);
	const messageSid = (messageGuid ? rememberIMessageReplyCache({
		accountId: decision.route.accountId,
		messageId: messageGuid,
		chatGuid: decision.chatGuid,
		chatIdentifier: decision.chatIdentifier,
		chatId: decision.chatId,
		timestamp: Date.now(),
		isFromMe: false
	}) : null)?.shortId || void 0;
	const replySuffix = decision.replyContext ? `\n\n[Replying to ${decision.replyContext.sender ?? "unknown sender"}${decision.replyContext.id ? ` id:${decision.replyContext.id}` : ""}]\n${decision.replyContext.body}\n[/Replying]` : "";
	const fromLabel = formatInboundFromLabel({
		isGroup: decision.isGroup,
		groupLabel: params.message.chat_name ?? void 0,
		groupId: chatId !== void 0 ? String(chatId) : "unknown",
		groupFallback: "Group",
		directLabel: decision.senderNormalized,
		directId: decision.sender
	});
	let combinedBody = formatInboundEnvelope({
		channel: "iMessage",
		from: fromLabel,
		timestamp: decision.createdAt,
		body: `${decision.bodyText}${replySuffix}`,
		chatType: decision.isGroup ? "group" : "direct",
		sender: {
			name: decision.senderNormalized,
			id: decision.sender
		},
		previousTimestamp: params.previousTimestamp,
		envelope: envelopeOptions
	});
	if (decision.isGroup && decision.historyKey) combinedBody = createChannelHistoryWindow({ historyMap: params.groupHistories }).buildPendingContext({
		historyKey: decision.historyKey,
		limit: params.historyLimit,
		currentMessage: combinedBody,
		formatEntry: (entry) => formatInboundEnvelope({
			channel: "iMessage",
			from: fromLabel,
			timestamp: entry.timestamp,
			body: `${entry.body}${entry.messageId ? ` [id:${entry.messageId}]` : ""}`,
			chatType: "group",
			senderLabel: entry.sender,
			envelope: envelopeOptions
		})
	});
	const imessageTo = (decision.isGroup ? chatTarget : void 0) || `imessage:${decision.sender}`;
	const inboundHistory = decision.isGroup && decision.historyKey && params.historyLimit > 0 ? createChannelHistoryWindow({ historyMap: params.groupHistories }).buildInboundHistory({
		historyKey: decision.historyKey,
		limit: params.historyLimit
	}) : void 0;
	return {
		ctxPayload: finalizeInboundContext({
			Body: combinedBody,
			BodyForAgent: decision.bodyText,
			InboundHistory: inboundHistory,
			RawBody: decision.bodyText,
			CommandBody: decision.bodyText,
			From: decision.isGroup ? `imessage:group:${chatId ?? "unknown"}` : `imessage:${decision.sender}`,
			To: imessageTo,
			SessionKey: decision.route.sessionKey,
			AccountId: decision.route.accountId,
			ChatType: decision.isGroup ? "group" : "direct",
			ConversationLabel: fromLabel,
			GroupSubject: decision.isGroup ? params.message.chat_name ?? void 0 : void 0,
			GroupSystemPrompt: decision.isGroup ? decision.groupSystemPrompt : void 0,
			GroupMembers: decision.isGroup ? (params.message.participants ?? []).filter(Boolean).join(", ") : void 0,
			SenderName: decision.senderNormalized,
			SenderId: decision.sender,
			Provider: "imessage",
			Surface: "imessage",
			MessageSid: messageSid,
			MessageSidFull: messageGuid,
			ReplyToId: decision.replyContext?.id,
			ReplyToBody: decision.replyContext?.body,
			ReplyToSender: decision.replyContext?.sender,
			Timestamp: decision.createdAt,
			MediaPath: params.media?.path,
			MediaType: params.media?.type,
			MediaUrl: params.media?.path,
			MediaPaths: params.media?.paths && params.media.paths.length > 0 ? params.media.paths : void 0,
			MediaTypes: params.media?.types && params.media.types.length > 0 ? params.media.types : void 0,
			MediaUrls: params.media?.paths && params.media.paths.length > 0 ? params.media.paths : void 0,
			MediaRemoteHost: params.remoteHost,
			WasMentioned: decision.effectiveWasMentioned,
			CommandAuthorized: decision.commandAuthorized,
			OriginatingChannel: "imessage",
			OriginatingTo: imessageTo
		}),
		fromLabel,
		chatTarget,
		imessageTo,
		inboundHistory
	};
}
function buildIMessageEchoScope(params) {
	const scopes = [];
	if (params.isGroup) {
		const chatIdScope = formatIMessageChatTarget(params.chatId);
		if (chatIdScope) scopes.push(`${params.accountId}:${chatIdScope}`);
	} else scopes.push(`${params.accountId}:imessage:${params.sender}`);
	if (params.chatGuid) scopes.push(`${params.accountId}:chat_guid:${params.chatGuid}`);
	if (params.chatIdentifier) scopes.push(`${params.accountId}:chat_identifier:${params.chatIdentifier}`);
	return scopes;
}
function describeIMessageEchoDropLog(params) {
	const preview = truncateUtf16Safe(params.messageText, 50);
	return `imessage: skipping echo message${params.messageId ? ` id=${params.messageId}` : ""}: "${preview}"`;
}
//#endregion
//#region extensions/imessage/src/monitor/loop-rate-limiter.ts
/**
* Per-conversation rate limiter that detects rapid-fire identical echo
* patterns and suppresses them before they amplify into queue overflow.
*/
const DEFAULT_WINDOW_MS = 6e4;
const DEFAULT_MAX_HITS = 5;
const CLEANUP_INTERVAL_MS = 12e4;
function createLoopRateLimiter(opts) {
	const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
	const maxHits = opts?.maxHits ?? DEFAULT_MAX_HITS;
	const conversations = /* @__PURE__ */ new Map();
	let lastCleanup = Date.now();
	function cleanup() {
		const now = Date.now();
		if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
		lastCleanup = now;
		for (const [key, win] of conversations.entries()) {
			const recent = win.timestamps.filter((ts) => now - ts <= windowMs);
			if (recent.length === 0) conversations.delete(key);
			else win.timestamps = recent;
		}
	}
	return {
		record(conversationKey) {
			cleanup();
			let win = conversations.get(conversationKey);
			if (!win) {
				win = { timestamps: [] };
				conversations.set(conversationKey, win);
			}
			win.timestamps.push(Date.now());
		},
		isRateLimited(conversationKey) {
			cleanup();
			const win = conversations.get(conversationKey);
			if (!win) return false;
			const now = Date.now();
			const recent = win.timestamps.filter((ts) => now - ts <= windowMs);
			win.timestamps = recent;
			return recent.length >= maxHits;
		}
	};
}
//#endregion
//#region extensions/imessage/src/monitor/media-staging.ts
function isHeicAttachment(attachmentPath, mimeType) {
	const normalizedMime = mimeType?.toLowerCase();
	if (normalizedMime === "image/heic" || normalizedMime === "image/heif") return true;
	const ext = path.extname(attachmentPath).toLowerCase();
	return ext === ".heic" || ext === ".heif";
}
function jpegFilenameForAttachment(attachmentPath) {
	return `${path.parse(attachmentPath).name || "imessage-attachment"}.jpg`;
}
function hasWildcardSegment(root) {
	return root.replaceAll("\\", "/").split("/").includes("*");
}
async function canonicalizeAllowedRoots(roots) {
	const canonicalRoots = [];
	for (const root of roots) {
		canonicalRoots.push(root);
		if (hasWildcardSegment(root)) continue;
		const canonicalRoot = await fs$1.realpath(root).catch(() => void 0);
		if (canonicalRoot && canonicalRoot !== root) canonicalRoots.push(canonicalRoot);
	}
	return canonicalRoots;
}
async function resolveAllowedCanonicalAttachmentPath(params) {
	if (!params.allowedRoots) return params.attachmentPath;
	const canonicalPath = await fs$1.realpath(params.attachmentPath);
	if (!isInboundPathAllowed({
		filePath: canonicalPath,
		roots: await canonicalizeAllowedRoots(params.allowedRoots)
	})) throw new Error("attachment path resolves outside allowed roots");
	return canonicalPath;
}
async function readAttachmentBuffer(params) {
	const stat = await fs$1.lstat(params.attachmentPath);
	if (stat.isSymbolicLink()) throw new Error("attachment path is a symlink");
	if (!stat.isFile()) throw new Error("attachment path is not a file");
	if (stat.size > params.maxBytes) throw new Error(`attachment exceeds ${Math.round(params.maxBytes / (1024 * 1024))}MB limit`);
	const canonicalPath = await resolveAllowedCanonicalAttachmentPath({
		attachmentPath: params.attachmentPath,
		allowedRoots: params.allowedRoots
	});
	const canonicalStat = await fs$1.stat(canonicalPath);
	if (!canonicalStat.isFile()) throw new Error("attachment path is not a file");
	if (canonicalStat.size > params.maxBytes) throw new Error(`attachment exceeds ${Math.round(params.maxBytes / (1024 * 1024))}MB limit`);
	if (isHeicAttachment(params.attachmentPath, params.mimeType)) try {
		const convert = params.deps.convertHeicToJpeg;
		const converted = convert ? {
			buffer: await convert(canonicalPath, params.maxBytes),
			fileName: jpegFilenameForAttachment(params.attachmentPath)
		} : await loadWebMedia(canonicalPath, {
			maxBytes: params.maxBytes,
			localRoots: [path.dirname(canonicalPath)]
		});
		return {
			buffer: converted.buffer,
			contentType: "image/jpeg",
			originalFilename: converted.fileName ?? jpegFilenameForAttachment(params.attachmentPath)
		};
	} catch (err) {
		params.deps.logVerbose?.(`imessage: HEIC attachment conversion failed; staging original instead: ${String(err)}`);
	}
	return {
		buffer: await fs$1.readFile(canonicalPath),
		contentType: params.mimeType ?? void 0,
		originalFilename: path.basename(params.attachmentPath)
	};
}
async function stageIMessageAttachments(attachments, params) {
	const deps = params.deps ?? {};
	const save = deps.saveMediaBuffer ?? saveMediaBuffer;
	const staged = [];
	for (const attachment of attachments) {
		const attachmentPath = attachment.original_path?.trim();
		if (!attachmentPath || attachment.missing) continue;
		try {
			const media = await readAttachmentBuffer({
				attachmentPath,
				mimeType: attachment.mime_type,
				maxBytes: params.maxBytes,
				allowedRoots: params.allowedRoots,
				deps
			});
			const saved = await save(media.buffer, media.contentType, "inbound", params.maxBytes, media.originalFilename);
			staged.push({
				path: saved.path,
				contentType: saved.contentType
			});
		} catch (err) {
			deps.logVerbose?.(`imessage: failed to stage inbound attachment: ${String(err)}`);
		}
	}
	return staged;
}
//#endregion
//#region extensions/imessage/src/monitor/reaction-system-event.ts
function enqueueIMessageReactionSystemEvent(params) {
	const { decision, runtime } = params;
	const queued = enqueueSystemEvent(decision.text, {
		sessionKey: decision.route.sessionKey,
		contextKey: decision.contextKey
	});
	runtime.log?.(`imessage: reaction system event ${queued ? "queued" : "deduped"} session=${decision.route.sessionKey} target=${decision.reaction.targetGuid ?? "unknown"} action=${decision.reaction.action} emoji=${decision.reaction.emoji}`);
	params.logVerbose?.(`imessage: reaction event enqueued: ${decision.text}`);
	return queued;
}
//#endregion
//#region extensions/imessage/src/monitor/runtime.ts
function resolveRuntime(opts) {
	return opts.runtime ?? createNonExitingRuntime();
}
function normalizeAllowList(list) {
	return normalizeStringEntries(list);
}
//#endregion
//#region extensions/imessage/src/monitor/self-chat-cache.ts
const SELF_CHAT_TTL_MS = 1e4;
const MAX_SELF_CHAT_CACHE_ENTRIES = 512;
const CLEANUP_MIN_INTERVAL_MS = 1e3;
function normalizeText(text) {
	if (!text) return null;
	const normalized = text.replace(/\r\n?/g, "\n").trim();
	return normalized ? normalized : null;
}
function isUsableTimestamp(createdAt) {
	return typeof createdAt === "number" && Number.isFinite(createdAt);
}
function digestText(text) {
	return createHash("sha256").update(text).digest("hex");
}
function buildScope(parts) {
	if (!parts.isGroup) return `${parts.accountId}:imessage:${parts.sender}`;
	const chatTarget = formatIMessageChatTarget(parts.chatId) || "chat_id:unknown";
	return `${parts.accountId}:${chatTarget}:imessage:${parts.sender}`;
}
var DefaultSelfChatCache = class {
	constructor() {
		this.cache = /* @__PURE__ */ new Map();
		this.lastCleanupAt = 0;
	}
	buildKey(lookup) {
		const text = normalizeText(lookup.text);
		if (!text || !isUsableTimestamp(lookup.createdAt)) return null;
		return `${buildScope(lookup)}:${lookup.createdAt}:${digestText(text)}`;
	}
	remember(lookup) {
		const key = this.buildKey(lookup);
		if (!key) return;
		this.cache.set(key, Date.now());
		this.maybeCleanup();
	}
	has(lookup) {
		this.maybeCleanup();
		const key = this.buildKey(lookup);
		if (!key) return false;
		const timestamp = this.cache.get(key);
		return typeof timestamp === "number" && Date.now() - timestamp <= SELF_CHAT_TTL_MS;
	}
	maybeCleanup() {
		const now = Date.now();
		if (now - this.lastCleanupAt < CLEANUP_MIN_INTERVAL_MS) return;
		this.lastCleanupAt = now;
		for (const [key, timestamp] of this.cache.entries()) if (now - timestamp > SELF_CHAT_TTL_MS) this.cache.delete(key);
		while (this.cache.size > MAX_SELF_CHAT_CACHE_ENTRIES) {
			const oldestKey = this.cache.keys().next().value;
			if (typeof oldestKey !== "string") break;
			this.cache.delete(oldestKey);
		}
	}
};
function createSelfChatCache() {
	return new DefaultSelfChatCache();
}
//#endregion
//#region extensions/imessage/src/monitor/watch-error-log.ts
const MAX_WATCH_ERROR_MESSAGE_CHARS = 200;
function sanitizeIMessageWatchErrorPayload(payload) {
	if (!isRecord(payload)) return {};
	const safe = {};
	if (typeof payload.code === "number" && Number.isFinite(payload.code)) safe.code = payload.code;
	if (typeof payload.message === "string") {
		const sanitizedMessage = sanitizeTerminalText(payload.message);
		if (sanitizedMessage) safe.message = sanitizedMessage.length > MAX_WATCH_ERROR_MESSAGE_CHARS ? `${truncateUtf16Safe(sanitizedMessage, MAX_WATCH_ERROR_MESSAGE_CHARS - 1)}…` : sanitizedMessage;
	}
	return safe;
}
//#endregion
//#region extensions/imessage/src/monitor/monitor-provider.ts
const WATCH_SUBSCRIBE_MAX_ATTEMPTS = 3;
const WATCH_SUBSCRIBE_RETRY_DELAY_MS = 1e3;
function isIMessagePluginPayloadAttachment(attachment) {
	const attachmentPath = attachment.original_path?.trim().toLowerCase() ?? "";
	const transferName = attachment.transfer_name?.trim().toLowerCase() ?? "";
	const uti = attachment.uti?.trim().toLowerCase() ?? "";
	return attachmentPath.endsWith(".pluginpayloadattachment") || transferName.endsWith(".pluginpayloadattachment") || uti === "com.apple.messages.pluginpayloadattachment";
}
async function detectRemoteHostFromCliPath(cliPath) {
	try {
		const expanded = cliPath.startsWith("~") ? cliPath.replace(/^~/, process.env.HOME ?? "") : cliPath;
		const content = await fs$1.readFile(expanded, "utf8");
		const userHostMatch = content.match(/\bssh\b[^\n]*?\s+([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+)/);
		if (userHostMatch) return userHostMatch[1];
		return content.match(/\bssh\b[^\n]*?\s+([a-zA-Z][a-zA-Z0-9._-]*)\s+\S*\bimsg\b/)?.[1];
	} catch (err) {
		const code = err?.code;
		if (code !== "ENOENT" && code !== "ENOTDIR") logVerbose(`imessage: failed to inspect cliPath ${cliPath} for remoteHost detection: ${String(err)}`);
		return;
	}
}
const warnIfImsgUpgradeNeeded = (() => {
	let fired = false;
	return { fireOnce: (rpcMethods, runtime) => {
		if (fired) return;
		fired = true;
		const detail = rpcMethods.length === 0 ? "imsg build pre-dates the rpc_methods capability list" : `imsg rpc_methods=[${rpcMethods.join(", ")}] does not include typing/read`;
		runtime.log?.(warn(`imessage: typing indicators / read receipts gated off (${detail}). Upgrade imsg (current bridge needs typing+read in rpc_methods).`));
	} };
})();
function isRetriableWatchSubscribeStartupError(error) {
	return /imsg rpc timeout \(watch\.subscribe\)|imsg rpc (closed|exited|not running)/i.test(String(error));
}
async function waitForWatchSubscribeRetryDelay(params) {
	if (params.ms <= 0) return;
	await new Promise((resolve) => {
		const timer = setTimeout(() => {
			params.abortSignal?.removeEventListener("abort", onAbort);
			resolve();
		}, params.ms);
		const onAbort = () => {
			clearTimeout(timer);
			params.abortSignal?.removeEventListener("abort", onAbort);
			resolve();
		};
		params.abortSignal?.addEventListener("abort", onAbort, { once: true });
	});
}
async function monitorIMessageProvider(opts = {}) {
	const runtime = resolveRuntime(opts);
	const cfg = opts.config ?? getRuntimeConfig();
	const accountInfo = resolveIMessageAccount({
		cfg,
		accountId: opts.accountId
	});
	const imessageCfg = accountInfo.config;
	const historyLimit = Math.max(0, imessageCfg.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? 50);
	const groupHistories = /* @__PURE__ */ new Map();
	const sentMessageCache = createSentMessageCache();
	const selfChatCache = createSelfChatCache();
	const loopRateLimiter = createLoopRateLimiter();
	const textLimit = resolveTextChunkLimit(cfg, "imessage", accountInfo.accountId);
	const allowFrom = normalizeAllowList(opts.allowFrom ?? imessageCfg.allowFrom);
	const configuredGroupAllowFrom = opts.groupAllowFrom ?? imessageCfg.groupAllowFrom;
	const groupAllowFrom = normalizeAllowList(configuredGroupAllowFrom ?? (imessageCfg.allowFrom && imessageCfg.allowFrom.length > 0 ? imessageCfg.allowFrom : []));
	const allowLegacyConversationAllowFromForGroup = configuredGroupAllowFrom == null;
	const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
	const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
		providerConfigPresent: cfg.channels?.imessage !== void 0,
		groupPolicy: imessageCfg.groupPolicy,
		defaultGroupPolicy
	});
	warnMissingProviderGroupPolicyFallbackOnce({
		providerMissingFallbackApplied,
		providerKey: "imessage",
		accountId: accountInfo.accountId,
		log: (message) => runtime.log?.(warn(message))
	});
	warnGroupAllowlistMisconfigOnce({
		groupPolicy,
		groups: imessageCfg.groups,
		accountId: accountInfo.accountId,
		log: (message) => runtime.log?.(warn(message))
	});
	const dmPolicy = imessageCfg.dmPolicy ?? "pairing";
	const includeAttachments = opts.includeAttachments ?? imessageCfg.includeAttachments ?? false;
	const mediaMaxBytes = (opts.mediaMaxMb ?? imessageCfg.mediaMaxMb ?? 16) * 1024 * 1024;
	const cliPath = opts.cliPath ?? imessageCfg.cliPath ?? "imsg";
	const dbPath = opts.dbPath ?? imessageCfg.dbPath;
	const probeTimeoutMs = imessageCfg.probeTimeoutMs ?? 1e4;
	const attachmentRoots = resolveIMessageAttachmentRoots({
		cfg,
		accountId: accountInfo.accountId
	});
	const remoteAttachmentRoots = resolveIMessageRemoteAttachmentRoots({
		cfg,
		accountId: accountInfo.accountId
	});
	const configuredRemoteHost = normalizeScpRemoteHost(imessageCfg.remoteHost);
	if (imessageCfg.remoteHost && !configuredRemoteHost) logVerbose("imessage: ignoring unsafe channels.imessage.remoteHost value");
	let remoteHost = configuredRemoteHost;
	if (!remoteHost && cliPath && cliPath !== "imsg") {
		const detected = await detectRemoteHostFromCliPath(cliPath);
		const normalizedDetected = normalizeScpRemoteHost(detected);
		if (detected && !normalizedDetected) logVerbose("imessage: ignoring unsafe auto-detected remoteHost from cliPath");
		remoteHost = normalizedDetected;
		if (remoteHost) logVerbose(`imessage: detected remoteHost=${remoteHost} from cliPath`);
	}
	const coalesceSameSenderDms = imessageCfg.coalesceSameSenderDms === true;
	const inboundCfg = cfg.messages?.inbound;
	const hasExplicitInboundDebounce = typeof inboundCfg?.debounceMs === "number" || typeof inboundCfg?.byChannel?.imessage === "number";
	const { debouncer: inboundDebouncer } = createChannelInboundDebouncer({
		cfg,
		channel: "imessage",
		debounceMsOverride: coalesceSameSenderDms && !hasExplicitInboundDebounce ? 2500 : void 0,
		buildKey: (entry) => {
			const msg = entry.message;
			const sender = msg.sender?.trim();
			if (!sender) return null;
			const conversationId = msg.chat_id != null ? `chat:${msg.chat_id}` : msg.chat_guid ?? msg.chat_identifier ?? "unknown";
			if (coalesceSameSenderDms && msg.is_group !== true) return `imessage:${accountInfo.accountId}:dm:${conversationId}:${sender}`;
			return `imessage:${accountInfo.accountId}:${conversationId}:${sender}`;
		},
		shouldDebounce: (entry) => {
			const msg = entry.message;
			if (resolveIMessageReactionContext(msg, (msg.text ?? "").trim())) return false;
			if (msg.is_from_me === true) return false;
			if (coalesceSameSenderDms) return msg.is_group !== true;
			return shouldDebounceTextInbound({
				text: msg.text,
				cfg,
				hasMedia: Boolean(msg.attachments?.some((attachment) => !isIMessagePluginPayloadAttachment(attachment)))
			});
		},
		onFlush: async (entries) => {
			if (entries.length === 0) return;
			if (entries.length === 1) {
				await handleMessageNow(entries[0].message);
				return;
			}
			const combined = combineIMessagePayloads(entries.map((e) => e.message));
			if (shouldLogVerbose()) {
				const text = combined.text ?? "";
				const preview = text.slice(0, 50);
				const ellipsis = text.length > 50 ? "..." : "";
				logVerbose(`[imessage] coalesced ${entries.length} messages: "${preview}${ellipsis}"`);
			}
			await handleMessageNow(combined);
		},
		onError: (err) => {
			runtime.error?.(`imessage debounce flush failed: ${String(err)}`);
		}
	});
	let client;
	let detachAbortHandler = () => {};
	const getActiveClient = () => {
		if (!client) throw new Error("imessage monitor client not initialized");
		return client;
	};
	async function handleMessageNow(message) {
		const messageText = (message.text ?? "").trim();
		const attachments = includeAttachments ? message.attachments ?? [] : [];
		const effectiveAttachmentRoots = remoteHost ? remoteAttachmentRoots : attachmentRoots;
		const validAttachments = attachments.filter((entry) => {
			if (isIMessagePluginPayloadAttachment(entry)) return false;
			const attachmentPath = entry?.original_path?.trim();
			if (!attachmentPath || entry?.missing) return false;
			if (isInboundPathAllowed({
				filePath: attachmentPath,
				roots: effectiveAttachmentRoots
			})) return true;
			logVerbose(`imessage: dropping inbound attachment outside allowed roots: ${attachmentPath}`);
			return false;
		});
		const rawMediaAttachments = validAttachments.flatMap((a) => {
			const attachmentPath = a.original_path?.trim();
			return attachmentPath ? [{
				path: attachmentPath,
				contentType: a.mime_type ?? void 0
			}] : [];
		});
		const placeholderMediaType = rawMediaAttachments[0]?.contentType;
		const kind = kindFromMime(placeholderMediaType ?? void 0);
		const placeholder = kind ? `<media:${kind}>` : validAttachments.length ? "<media:attachment>" : "";
		const bodyText = messageText || placeholder;
		const storeAllowFrom = await readChannelAllowFromStore("imessage", process.env, accountInfo.accountId).catch(() => []);
		const decision = await resolveIMessageInboundDecision({
			cfg,
			accountId: accountInfo.accountId,
			message,
			opts,
			messageText,
			bodyText,
			allowFrom,
			groupAllowFrom,
			allowLegacyConversationAllowFromForGroup,
			groupPolicy,
			dmPolicy,
			storeAllowFrom,
			historyLimit,
			groupHistories,
			echoCache: sentMessageCache,
			selfChatCache,
			reactionNotifications: imessageCfg.reactionNotifications,
			logVerbose
		});
		const chatId = message.chat_id ?? void 0;
		const senderForKey = (message.sender ?? "").trim();
		const conversationKey = chatId != null ? `group:${chatId}` : `dm:${senderForKey}`;
		const rateLimitKey = `${accountInfo.accountId}:${conversationKey}`;
		if (decision.kind === "drop") {
			if (decision.reason === "echo" || decision.reason === "self-chat echo" || decision.reason === "reflected assistant content" || decision.reason === "from me") loopRateLimiter.record(rateLimitKey);
			if (decision.reason === "group id not in allowlist") warnGroupAllowlistDropPerChatOnce({
				accountId: accountInfo.accountId,
				chatId: message.chat_id ?? void 0,
				log: (msg) => runtime.log?.(warn(msg))
			});
			return;
		}
		if (decision.kind === "dispatch" && loopRateLimiter.isRateLimited(rateLimitKey)) {
			logVerbose(`imessage: rate-limited conversation ${conversationKey} (echo loop detected)`);
			return;
		}
		if (decision.kind === "pairing") {
			const sender = (message.sender ?? "").trim();
			if (!sender) return;
			await createChannelPairingChallengeIssuer({
				channel: "imessage",
				upsertPairingRequest: async ({ id, meta }) => await upsertChannelPairingRequest({
					channel: "imessage",
					id,
					accountId: accountInfo.accountId,
					meta
				})
			})({
				senderId: decision.senderId,
				senderIdLine: `Your iMessage sender id: ${decision.senderId}`,
				meta: {
					sender: decision.senderId,
					chatId: chatId ? String(chatId) : void 0
				},
				onCreated: () => {
					logVerbose(`imessage pairing request sender=${decision.senderId}`);
				},
				sendPairingReply: async (text) => {
					await sendMessageIMessage(sender, text, {
						config: cfg,
						client: getActiveClient(),
						maxBytes: mediaMaxBytes,
						accountId: accountInfo.accountId,
						...chatId ? { chatId } : {}
					});
				},
				onReplyError: (err) => {
					runtime.error?.(`imessage pairing reply failed for ${decision.senderId}: ${String(err)}`);
				}
			});
			return;
		}
		if (decision.kind === "reaction") {
			enqueueIMessageReactionSystemEvent({
				decision,
				runtime,
				logVerbose
			});
			return;
		}
		const storePath = resolveStorePath(cfg.session?.store, { agentId: decision.route.agentId });
		const stagedAttachments = remoteHost ? [] : await stageIMessageAttachments(validAttachments, {
			maxBytes: mediaMaxBytes,
			allowedRoots: effectiveAttachmentRoots,
			deps: { logVerbose }
		});
		const mediaAttachments = remoteHost ? rawMediaAttachments : stagedAttachments;
		const firstAttachment = mediaAttachments[0];
		const mediaPath = firstAttachment?.path ?? void 0;
		const mediaType = firstAttachment?.contentType ?? void 0;
		const mediaPaths = mediaAttachments.map((a) => a.path).filter(Boolean);
		const mediaTypes = mediaAttachments.map((a) => a.contentType ?? void 0);
		const { ctxPayload, chatTarget } = buildIMessageInboundContext({
			cfg,
			decision,
			message,
			previousTimestamp: readSessionUpdatedAt({
				storePath,
				sessionKey: decision.route.sessionKey
			}),
			remoteHost,
			historyLimit,
			groupHistories,
			media: {
				path: mediaPath,
				type: mediaType,
				paths: mediaPaths,
				types: mediaTypes
			}
		});
		const updateTarget = chatTarget || decision.sender;
		const pinnedMainDmOwner = resolvePinnedMainDmOwnerFromAllowlist({
			dmScope: cfg.session?.dmScope,
			allowFrom,
			normalizeEntry: normalizeIMessageHandle
		});
		if (shouldLogVerbose()) {
			const preview = truncateUtf16Safe(ctxPayload.Body ?? "", 200).replace(/\n/g, "\\n");
			logVerbose(`imessage inbound: chatId=${chatId ?? "unknown"} from=${ctxPayload.From} len=${(ctxPayload.Body ?? "").length} preview="${preview}"`);
		}
		const privateApiStatus = getCachedIMessagePrivateApiStatus(cliPath);
		const supportsTyping = imessageRpcSupportsMethod(privateApiStatus, "typing");
		const supportsRead = imessageRpcSupportsMethod(privateApiStatus, "read");
		if (privateApiStatus?.available === true) {
			if (!supportsTyping || !supportsRead) warnIfImsgUpgradeNeeded.fireOnce(privateApiStatus.rpcMethods, runtime);
		}
		const sendReadReceipts = imessageCfg.sendReadReceipts !== false;
		const typingTarget = ctxPayload.To;
		if (supportsRead && sendReadReceipts && typingTarget) try {
			await markIMessageChatRead(typingTarget, {
				cfg,
				accountId: accountInfo.accountId,
				client: getActiveClient()
			});
		} catch (err) {
			runtime.error?.(`imessage: mark read failed: ${String(err)}`);
		}
		const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
			cfg,
			agentId: decision.route.agentId,
			channel: "imessage",
			accountId: decision.route.accountId,
			typing: supportsTyping && typingTarget ? {
				start: async () => {
					await sendIMessageTyping(typingTarget, true, {
						cfg,
						accountId: accountInfo.accountId,
						client: getActiveClient()
					});
				},
				stop: async () => {
					await sendIMessageTyping(typingTarget, false, {
						cfg,
						accountId: accountInfo.accountId,
						client: getActiveClient()
					});
				},
				onStartError: (err) => {
					logTypingFailure({
						log: (msg) => logVerbose(msg),
						channel: "imessage",
						action: "start",
						target: typingTarget,
						error: err
					});
				},
				onStopError: (err) => {
					logTypingFailure({
						log: (msg) => logVerbose(msg),
						channel: "imessage",
						action: "stop",
						target: typingTarget,
						error: err
					});
				}
			} : void 0
		});
		const { dispatcher, replyOptions: typingReplyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
			...replyPipeline,
			humanDelay: resolveHumanDelayConfig(cfg, decision.route.agentId),
			deliver: async (payload, info) => {
				const target = ctxPayload.To;
				if (!target) {
					runtime.error?.(danger("imessage: missing delivery target"));
					return;
				}
				const durable = await deliverInboundReplyWithMessageSendContext({
					cfg,
					channel: "imessage",
					accountId: accountInfo.accountId,
					agentId: decision.route.agentId,
					ctxPayload,
					payload,
					info,
					to: target,
					deps: { imessage: createIMessageEchoCachingSend({
						client: getActiveClient(),
						accountId: accountInfo.accountId,
						sentMessageCache
					}) }
				});
				if (durable.status === "failed") throw durable.error;
				if (durable.status === "handled_visible" || durable.status === "handled_no_send") return;
				await deliverReplies({
					cfg,
					replies: [payload],
					target,
					client: getActiveClient(),
					accountId: accountInfo.accountId,
					runtime,
					maxBytes: mediaMaxBytes,
					textLimit,
					sentMessageCache
				});
			},
			onError: (err, info) => {
				runtime.error?.(danger(`imessage ${info.kind} reply failed: ${String(err)}`));
			}
		});
		const inboundLastRouteSessionKey = resolveInboundLastRouteSessionKey({
			route: decision.route,
			sessionKey: decision.route.sessionKey
		});
		await runInboundReplyTurn({
			channel: "imessage",
			accountId: decision.route.accountId,
			raw: decision,
			adapter: {
				ingest: () => ({
					id: ctxPayload.MessageSid ?? `${ctxPayload.From}:${Date.now()}`,
					timestamp: typeof ctxPayload.Timestamp === "number" ? ctxPayload.Timestamp : void 0,
					rawText: ctxPayload.RawBody ?? "",
					textForAgent: ctxPayload.BodyForAgent,
					textForCommands: ctxPayload.CommandBody,
					raw: decision
				}),
				resolveTurn: () => ({
					channel: "imessage",
					accountId: decision.route.accountId,
					routeSessionKey: decision.route.sessionKey,
					storePath,
					ctxPayload,
					recordInboundSession,
					record: {
						updateLastRoute: !decision.isGroup && updateTarget ? {
							sessionKey: inboundLastRouteSessionKey,
							channel: "imessage",
							to: updateTarget,
							accountId: decision.route.accountId,
							mainDmOwnerPin: inboundLastRouteSessionKey === decision.route.mainSessionKey && pinnedMainDmOwner && decision.senderNormalized ? {
								ownerRecipient: pinnedMainDmOwner,
								senderRecipient: decision.senderNormalized,
								onSkip: ({ ownerRecipient, senderRecipient }) => {
									logVerbose(`imessage: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`);
								}
							} : void 0
						} : void 0,
						onRecordError: (err) => {
							logVerbose(`imessage: failed updating session meta: ${String(err)}`);
						}
					},
					history: {
						isGroup: decision.isGroup,
						historyKey: decision.historyKey,
						historyMap: groupHistories,
						limit: historyLimit
					},
					onPreDispatchFailure: () => settleReplyDispatcher({
						dispatcher,
						onSettled: () => markDispatchIdle()
					}),
					runDispatch: async () => {
						try {
							return await dispatchInboundMessage({
								ctx: ctxPayload,
								cfg,
								dispatcher,
								replyOptions: {
									...typingReplyOptions,
									disableBlockStreaming: typeof accountInfo.config.blockStreaming === "boolean" ? !accountInfo.config.blockStreaming : void 0,
									onModelSelected
								}
							});
						} finally {
							markDispatchIdle();
						}
					}
				})
			}
		});
	}
	const handleMessage = async (raw) => {
		const message = parseIMessageNotification(raw);
		if (!message) {
			const shape = raw && typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw).toSorted().join(",") : typeof raw;
			runtime.error?.(`imessage: dropping malformed RPC message payload (keys=${shape})`);
			return;
		}
		await inboundDebouncer.enqueue({ message });
	};
	await waitForTransportReady({
		label: "imsg rpc",
		timeoutMs: 3e4,
		logAfterMs: 1e4,
		logIntervalMs: 1e4,
		pollIntervalMs: 500,
		abortSignal: opts.abortSignal,
		runtime,
		check: async () => {
			const probe = await probeIMessage(probeTimeoutMs, {
				cliPath,
				dbPath,
				runtime
			});
			if (probe.ok) return { ok: true };
			if (probe.fatal) throw new Error(probe.error ?? "imsg rpc unavailable");
			return {
				ok: false,
				error: probe.error ?? "unreachable"
			};
		}
	});
	if (opts.abortSignal?.aborted) return;
	const abort = opts.abortSignal;
	const createWatchClient = async () => await createIMessageRpcClient({
		cliPath,
		dbPath,
		runtime,
		onNotification: (msg) => {
			if (msg.method === "message") handleMessage(msg.params).catch((err) => {
				runtime.error?.(`imessage: handler failed: ${String(err)}`);
			});
			else if (msg.method === "error") runtime.error?.(`imessage: watch error ${JSON.stringify(sanitizeIMessageWatchErrorPayload(msg.params))}`);
		}
	});
	const requireWatchClient = (watchClient) => {
		if (!watchClient) throw new Error("imessage monitor client not initialized");
		return watchClient;
	};
	for (let attempt = 1; attempt <= WATCH_SUBSCRIBE_MAX_ATTEMPTS; attempt++) {
		if (abort?.aborted) return;
		let attemptClient;
		let attemptDetachAbortHandler = () => {};
		let keepAttemptClient = false;
		try {
			attemptClient = requireWatchClient(await createWatchClient());
			let attemptSubscriptionId = null;
			attemptDetachAbortHandler = attachIMessageMonitorAbortHandler({
				abortSignal: abort,
				client: attemptClient,
				getSubscriptionId: () => attemptSubscriptionId
			});
			attemptSubscriptionId = (await attemptClient.request("watch.subscribe", {
				attachments: includeAttachments,
				include_reactions: true
			}, { timeoutMs: probeTimeoutMs }))?.subscription ?? null;
			client = attemptClient;
			detachAbortHandler = attemptDetachAbortHandler;
			keepAttemptClient = true;
			break;
		} catch (err) {
			if (abort?.aborted) return;
			if (!(attempt < WATCH_SUBSCRIBE_MAX_ATTEMPTS && isRetriableWatchSubscribeStartupError(err))) {
				runtime.error?.(danger(`imessage: monitor failed: ${String(err)}`));
				throw err;
			}
			runtime.log?.(warn(`imessage: watch.subscribe startup failed (attempt ${attempt}/${WATCH_SUBSCRIBE_MAX_ATTEMPTS}): ${String(err)}; retrying`));
			attemptDetachAbortHandler();
			attemptDetachAbortHandler = () => {};
			await attemptClient?.stop();
			attemptClient = void 0;
			await waitForWatchSubscribeRetryDelay({
				ms: WATCH_SUBSCRIBE_RETRY_DELAY_MS,
				abortSignal: abort
			});
			if (abort?.aborted) return;
		} finally {
			if (!keepAttemptClient) {
				attemptDetachAbortHandler();
				await attemptClient?.stop();
			}
		}
	}
	const activeClient = client;
	if (!activeClient) return;
	const catchupCfg = resolveCatchupConfig(imessageCfg.catchup);
	if (catchupCfg.enabled && !abort?.aborted) try {
		await runIMessageCatchup({
			client: activeClient,
			accountId: accountInfo.accountId,
			config: catchupCfg,
			includeAttachments,
			dispatchPayload: (message) => handleMessageNow(message),
			runtime
		});
	} catch (err) {
		runtime.error?.(`imessage catchup: pass failed: ${String(err)}`);
	}
	try {
		await activeClient.waitForClose();
	} catch (err) {
		if (abort?.aborted) return;
		runtime.error?.(danger(`imessage: monitor failed: ${String(err)}`));
		throw err;
	} finally {
		detachAbortHandler();
		await activeClient.stop();
	}
}
//#endregion
export { sendMessageIMessage as n, monitorIMessageProvider as t };
