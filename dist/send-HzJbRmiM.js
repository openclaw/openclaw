import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { s as redactSensitiveText } from "./redact-ok5Q8nmw.js";
import { a as formatUncaughtError, i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as isDiagnosticFlagEnabled } from "./diagnostic-flags-Bss2g5Mq.js";
import { i as replaceFileAtomicSync } from "./replace-file-C7_Inj8B.js";
import { r as logVerbose } from "./globals-YU5FjfZK.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { d as readConfigFileSnapshotForWrite } from "./io-DoswVvYe.js";
import { i as replaceConfigFile } from "./mutate-DLC8bveh.js";
import { u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { c as kindFromMime, s as isGifMedia } from "./mime-DppuT-pZ.js";
import { i as saveCronStore, r as resolveCronStorePath, t as loadCronStore } from "./store-PoorarMW.js";
import { c as getImageMetadata, n as probeVideoDimensions } from "./media-services-CLFjOJQs.js";
import { t as loadWebMedia } from "./web-media-GlH39bZn.js";
import { n as normalizePollInput } from "./polls-C-v11_tu.js";
import { r as makeProxyFetch } from "./proxy-fetch-B02LTFkt.js";
import { t as buildOutboundMediaLoadOptions } from "./load-options-LnfEFXDj.js";
import { o as normalizeTelegramApiRoot, r as resolveTelegramTransport } from "./fetch-Dy1LisTE.js";
import "./error-runtime-DGHc7DZw.js";
import "./runtime-env-BtvWnLRh.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { a as isRecoverableTelegramNetworkError, c as isTelegramMisdirectedRequestError, d as isTelegramServerError, f as tagTelegramNetworkError, o as isSafeToRetrySendError, r as resolveTelegramRequestTimeoutMs, u as isTelegramRateLimitError } from "./request-timeouts-CnvnuqEE.js";
import { t as resolveMarkdownTableMode } from "./markdown-tables-DCRkoyVz.js";
import { n as recordChannelActivity } from "./channel-activity-eMQlJ3BE.js";
import { r as isVoiceCompatibleAudio } from "./audio-CVFIRHpA.js";
import { t as requireRuntimeConfig } from "./plugin-config-runtime-DWa7yCpn.js";
import "./config-mutation-C9bUHI1l.js";
import "./cron-store-runtime-DdRzYspA.js";
import "./web-media-Q6WLwwDo.js";
import { n as createChannelApiRetryRunner } from "./retry-policy-C4ndkoIo.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./media-runtime-BheBFFxc.js";
import "./security-runtime-CcSekjBd.js";
import "./logging-core-DwEC9Ajh.js";
import "./markdown-table-runtime-BRMInqmJ.js";
import "./session-store-runtime-DCQkOAps.js";
import "./retry-runtime-BLxc3H40.js";
import { o as resolveTelegramAccount } from "./accounts-CYn64t2S.js";
import { i as parseTelegramTarget, n as normalizeTelegramChatId, r as normalizeTelegramLookupTarget } from "./targets-D0gFWyUZ.js";
import { J as normalizeTelegramReplyToMessageId, a as renderTelegramHtmlText, g as buildTypingThreadParams, h as buildTelegramThreadParams, o as splitTelegramHtmlChunks, s as telegramHtmlToPlainTextFallback } from "./format-B4PA8GD8.js";
import fs from "node:fs";
import * as grammy from "grammy";
import { Bot, Bot as Bot$1, HttpError } from "grammy";
import { sequentialize } from "@grammyjs/runner";
import { apiThrottler } from "@grammyjs/transformer-throttler";
//#region extensions/telegram/src/account-throttler.ts
var GroupFairQueue = class {
	constructor() {
		this.lanes = /* @__PURE__ */ new Map();
		this.laneOrder = [];
		this.nextLaneIndex = 0;
		this.running = false;
	}
	enqueue(laneKey, run) {
		return new Promise((resolve, reject) => {
			const request = {
				run,
				resolve,
				reject
			};
			const existing = this.lanes.get(laneKey);
			if (existing) existing.push(request);
			else {
				this.lanes.set(laneKey, [request]);
				this.laneOrder.push(laneKey);
			}
			this.start();
		});
	}
	start() {
		if (this.running) return;
		this.running = true;
		this.drain();
	}
	async drain() {
		try {
			while (true) {
				const request = this.takeNext();
				if (!request) return;
				try {
					request.resolve(await request.run());
				} catch (err) {
					request.reject(err);
				}
			}
		} finally {
			this.running = false;
			if (this.laneOrder.length > 0) this.start();
		}
	}
	takeNext() {
		for (let scanned = 0; scanned < this.laneOrder.length; scanned += 1) {
			this.nextLaneIndex %= this.laneOrder.length;
			const laneKey = this.laneOrder[this.nextLaneIndex];
			const queue = this.lanes.get(laneKey);
			if (!queue || queue.length === 0) {
				this.lanes.delete(laneKey);
				this.laneOrder.splice(this.nextLaneIndex, 1);
				if (this.laneOrder.length === 0) {
					this.nextLaneIndex = 0;
					return;
				}
				continue;
			}
			const request = queue.shift();
			this.nextLaneIndex += 1;
			return request;
		}
	}
};
const throttlerByToken = /* @__PURE__ */ new Map();
function readNumericId(value) {
	if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : void 0;
	if (typeof value !== "string") return;
	const numeric = Number(value.trim());
	return Number.isFinite(numeric) ? Math.trunc(numeric) : void 0;
}
function readPayload(payload) {
	return payload && typeof payload === "object" ? payload : void 0;
}
function resolveGroupChatKey(payload) {
	const chatId = readNumericId(payload.chat_id);
	return chatId !== void 0 && chatId < 0 ? String(chatId) : void 0;
}
function resolveForumLaneKey(payload) {
	const threadId = readNumericId(payload.message_thread_id);
	if (threadId !== void 0) return `topic:${threadId}`;
	const directTopicId = readNumericId(payload.direct_messages_topic_id);
	if (directTopicId !== void 0) return `direct-topic:${directTopicId}`;
	const messageId = readNumericId(payload.message_id);
	if (messageId !== void 0) return `message:${messageId}`;
	return "main";
}
function createTelegramAccountThrottler(createThrottler = apiThrottler) {
	const baseThrottler = createThrottler();
	const fairQueuesByChat = /* @__PURE__ */ new Map();
	return (prev, method, payload, signal) => {
		const apiPayload = readPayload(payload);
		const groupChatKey = apiPayload ? resolveGroupChatKey(apiPayload) : void 0;
		if (!apiPayload || !groupChatKey) return baseThrottler(prev, method, payload, signal);
		let fairQueue = fairQueuesByChat.get(groupChatKey);
		if (!fairQueue) {
			fairQueue = new GroupFairQueue();
			fairQueuesByChat.set(groupChatKey, fairQueue);
		}
		const laneKey = resolveForumLaneKey(apiPayload);
		return fairQueue.enqueue(laneKey, () => baseThrottler(prev, method, payload, signal));
	};
}
function getOrCreateAccountThrottler(token, createThrottler = apiThrottler) {
	let throttler = throttlerByToken.get(token);
	if (!throttler) {
		throttler = createTelegramAccountThrottler(createThrottler);
		throttlerByToken.set(token, throttler);
	}
	return throttler;
}
//#endregion
//#region extensions/telegram/src/api-logging.ts
const fallbackLogger = createSubsystemLogger("telegram/api");
function resolveTelegramApiLogger(runtime, logger) {
	if (logger) return logger;
	if (runtime?.error) return runtime.error;
	return (message) => fallbackLogger.error(message);
}
async function withTelegramApiErrorLogging({ operation, fn, runtime, logger, shouldLog }) {
	try {
		return await fn();
	} catch (err) {
		if (!shouldLog || shouldLog(err)) {
			const errText = formatErrorMessage(err);
			resolveTelegramApiLogger(runtime, logger)(`telegram ${operation} failed: ${errText}`);
		}
		throw err;
	}
}
function splitTelegramCaption(text) {
	const trimmed = text?.trim() ?? "";
	if (!trimmed) return {
		caption: void 0,
		followUpText: void 0
	};
	if (trimmed.length > 1024) return {
		caption: void 0,
		followUpText: trimmed
	};
	return {
		caption: trimmed,
		followUpText: void 0
	};
}
//#endregion
//#region extensions/telegram/src/client-fetch.ts
function asTelegramClientFetch(fetchImpl) {
	return fetchImpl;
}
function asTelegramCompatFetch(fetchImpl) {
	return fetchImpl;
}
function isTelegramAbortSignalLike(value) {
	return typeof value === "object" && value !== null && "aborted" in value && typeof value.aborted === "boolean" && typeof value.addEventListener === "function" && typeof value.removeEventListener === "function";
}
function readRequestUrl(input) {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	return null;
}
function extractTelegramApiMethod(input) {
	const url = readRequestUrl(input);
	if (!url) return null;
	try {
		const segments = new URL(url).pathname.split("/").filter(Boolean);
		return normalizeOptionalLowercaseString(segments.length > 0 ? segments.at(-1) ?? null : null) ?? null;
	} catch {
		return null;
	}
}
const TELEGRAM_TIMEOUT_FALLBACK_METHODS = new Set([
	"deletemycommands",
	"deletewebhook",
	"getme",
	"sendchataction",
	"setmycommands",
	"setwebhook"
]);
function shouldRetryTimedOutTelegramControlRequest(method) {
	return method !== null && TELEGRAM_TIMEOUT_FALLBACK_METHODS.has(method);
}
function resolveTelegramClientTimeoutSeconds(params) {
	const { value, minimum } = params;
	if (typeof value !== "number" || !Number.isFinite(value)) return;
	const configured = Math.max(1, Math.floor(value));
	if (typeof minimum !== "number" || !Number.isFinite(minimum)) return configured;
	return Math.max(configured, Math.max(1, Math.floor(minimum)));
}
function resolveTelegramClientTimeoutMinimumSeconds(values) {
	let minimum;
	for (const value of values) {
		if (typeof value !== "number" || !Number.isFinite(value)) continue;
		const normalized = Math.max(1, Math.ceil(value));
		minimum = minimum === void 0 ? normalized : Math.max(minimum, normalized);
	}
	return minimum;
}
function resolveTelegramOutboundClientTimeoutFloorSeconds(timeoutSeconds) {
	const timeoutMs = resolveTelegramRequestTimeoutMs("sendmessage", timeoutSeconds);
	return timeoutMs === void 0 ? void 0 : timeoutMs / 1e3;
}
function createTelegramClientFetch(params) {
	if (!params.fetchImpl && !params.shutdownSignal) return;
	const callFetch = asTelegramCompatFetch(params.fetchImpl ?? asTelegramClientFetch(globalThis.fetch));
	const wrappedFetch = async (input, init) => {
		const method = extractTelegramApiMethod(input);
		const requestTimeoutMs = resolveTelegramRequestTimeoutMs(method, params.timeoutSeconds);
		const shutdownSignal = isTelegramAbortSignalLike(params.shutdownSignal) ? params.shutdownSignal : void 0;
		const requestSignal = isTelegramAbortSignalLike(init?.signal) ? init.signal : void 0;
		const canForceTransportFallback = (reason) => !shutdownSignal?.aborted && !requestSignal?.aborted && params.transport?.forceFallback?.(reason) === true;
		const runFetch = async () => {
			const controller = new AbortController();
			const abortWith = (signal) => controller.abort(signal.reason);
			const onShutdown = () => {
				if (shutdownSignal) abortWith(shutdownSignal);
			};
			let requestTimeout;
			let onRequestAbort;
			let requestTimedOut = false;
			const timeoutError = requestTimeoutMs !== void 0 ? /* @__PURE__ */ new Error(`Telegram ${method} timed out after ${requestTimeoutMs}ms`) : void 0;
			if (shutdownSignal?.aborted) abortWith(shutdownSignal);
			else if (shutdownSignal) shutdownSignal.addEventListener("abort", onShutdown, { once: true });
			if (requestSignal) if (requestSignal.aborted) abortWith(requestSignal);
			else {
				onRequestAbort = () => abortWith(requestSignal);
				requestSignal.addEventListener("abort", onRequestAbort);
			}
			if (requestTimeoutMs && timeoutError) {
				requestTimeout = setTimeout(() => {
					requestTimedOut = true;
					controller.abort(timeoutError);
				}, requestTimeoutMs);
				requestTimeout.unref?.();
			}
			try {
				return await callFetch(input, {
					...init,
					signal: controller.signal
				});
			} catch (err) {
				if (requestTimedOut && timeoutError) throw timeoutError;
				throw err;
			} finally {
				if (requestTimeout) clearTimeout(requestTimeout);
				shutdownSignal?.removeEventListener("abort", onShutdown);
				if (requestSignal && onRequestAbort) requestSignal.removeEventListener("abort", onRequestAbort);
			}
		};
		try {
			const response = await runFetch();
			if (response.status === 421 && canForceTransportFallback("misdirected-request")) return await runFetch();
			return response;
		} catch (err) {
			if (requestTimeoutMs && shouldRetryTimedOutTelegramControlRequest(method) && canForceTransportFallback("request-timeout")) return await runFetch();
			if (isTelegramMisdirectedRequestError(err) && canForceTransportFallback("misdirected-request")) return await runFetch();
			throw err;
		}
	};
	return (input, init) => {
		return Promise.resolve(wrappedFetch(input, init)).catch((err) => {
			try {
				tagTelegramNetworkError(err, {
					method: extractTelegramApiMethod(input),
					url: readRequestUrl(input)
				});
			} catch {}
			throw err;
		});
	};
}
//#endregion
//#region extensions/telegram/src/inline-keyboard.ts
function toInlineKeyboardButton(button) {
	if (!button?.text) return;
	if (button.url) return button.style ? {
		text: button.text,
		url: button.url,
		style: button.style
	} : {
		text: button.text,
		url: button.url
	};
	if (button.callback_data) return button.style ? {
		text: button.text,
		callback_data: button.callback_data,
		style: button.style
	} : {
		text: button.text,
		callback_data: button.callback_data
	};
	if (button.web_app?.url) return button.style ? {
		text: button.text,
		web_app: { url: button.web_app.url },
		style: button.style
	} : {
		text: button.text,
		web_app: { url: button.web_app.url }
	};
}
function buildInlineKeyboard(buttons) {
	if (!buttons?.length) return;
	const rows = buttons.map((row) => row.map(toInlineKeyboardButton).filter((button) => Boolean(button))).filter((row) => row.length > 0);
	if (rows.length === 0) return;
	return { inline_keyboard: rows };
}
//#endregion
//#region extensions/telegram/src/reply-parameters.ts
function resolveTelegramSendThreadSpec(params) {
	const messageThreadId = params.messageThreadId != null ? params.messageThreadId : params.targetMessageThreadId;
	if (messageThreadId == null) return;
	return {
		id: messageThreadId,
		scope: params.chatType === "direct" ? "dm" : "forum"
	};
}
function buildTelegramThreadReplyParams(opts) {
	const params = {};
	const threadParams = buildTelegramThreadParams(opts?.thread);
	if (threadParams) params.message_thread_id = threadParams.message_thread_id;
	const replyToMessageId = normalizeTelegramReplyToMessageId(opts?.replyToMessageId);
	if (replyToMessageId == null) return params;
	const defaultQuoteMessageId = opts?.useReplyIdAsQuoteSource === true ? replyToMessageId : void 0;
	const replyQuoteTextRaw = normalizeTelegramReplyToMessageId(opts?.replyQuoteMessageId ?? defaultQuoteMessageId) === replyToMessageId ? opts?.replyQuoteText : void 0;
	const replyQuoteText = replyQuoteTextRaw?.trim() ? replyQuoteTextRaw : void 0;
	if (!replyQuoteText) {
		params.reply_to_message_id = replyToMessageId;
		params.allow_sending_without_reply = true;
		return params;
	}
	const replyParameters = {
		message_id: replyToMessageId,
		quote: replyQuoteText,
		allow_sending_without_reply: true
	};
	if (typeof opts?.replyQuotePosition === "number" && Number.isFinite(opts.replyQuotePosition)) replyParameters.quote_position = Math.trunc(opts.replyQuotePosition);
	if (Array.isArray(opts?.replyQuoteEntities) && opts.replyQuoteEntities.length > 0) replyParameters.quote_entities = opts.replyQuoteEntities;
	params.reply_parameters = replyParameters;
	return params;
}
function buildTelegramSendParams(opts) {
	const params = { ...buildTelegramThreadReplyParams(opts) };
	if (opts?.silent === true) params.disable_notification = true;
	return params;
}
function getTelegramNativeQuoteReplyMessageId(params) {
	const replyParameters = params?.reply_parameters;
	if (!replyParameters || typeof replyParameters !== "object") return;
	const messageId = replyParameters.message_id;
	return typeof messageId === "number" && Number.isFinite(messageId) ? messageId : void 0;
}
function removeTelegramNativeQuoteParam(params) {
	if (!params) return {};
	const replyMessageId = getTelegramNativeQuoteReplyMessageId(params);
	const { reply_parameters: _ignored, ...rest } = params;
	if (replyMessageId != null) {
		rest.reply_to_message_id = replyMessageId;
		rest.allow_sending_without_reply = true;
	}
	return rest;
}
//#endregion
//#region extensions/telegram/src/sent-message-cache.ts
const TTL_MS = 1440 * 60 * 1e3;
const TELEGRAM_SENT_MESSAGES_STATE_KEY = Symbol.for("openclaw.telegramSentMessagesState");
function getSentMessageState() {
	const globalStore = globalThis;
	const existing = globalStore[TELEGRAM_SENT_MESSAGES_STATE_KEY];
	if (existing) return existing;
	const state = { bucketsByPath: /* @__PURE__ */ new Map() };
	globalStore[TELEGRAM_SENT_MESSAGES_STATE_KEY] = state;
	return state;
}
function createSentMessageStore() {
	return /* @__PURE__ */ new Map();
}
function resolveSentMessageStorePath(cfg) {
	return `${resolveStorePath(cfg?.session?.store)}.telegram-sent-messages.json`;
}
function cleanupExpired(store, scopeKey, entry, now) {
	for (const [id, timestamp] of entry) if (now - timestamp > TTL_MS) entry.delete(id);
	if (entry.size === 0) store.delete(scopeKey);
}
function readPersistedSentMessages(filePath) {
	if (!fs.existsSync(filePath)) return createSentMessageStore();
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw);
		const now = Date.now();
		const store = createSentMessageStore();
		for (const [chatId, entry] of Object.entries(parsed)) {
			const messages = /* @__PURE__ */ new Map();
			for (const [messageId, timestamp] of Object.entries(entry)) if (typeof timestamp === "number" && Number.isFinite(timestamp) && now - timestamp <= TTL_MS) messages.set(messageId, timestamp);
			if (messages.size > 0) store.set(chatId, messages);
		}
		return store;
	} catch (error) {
		logVerbose(`telegram: failed to read sent-message cache: ${String(error)}`);
		return createSentMessageStore();
	}
}
function getSentMessageBucket(cfg) {
	const state = getSentMessageState();
	const persistedPath = resolveSentMessageStorePath(cfg);
	const existing = state.bucketsByPath.get(persistedPath);
	if (existing) return existing;
	const bucket = {
		persistedPath,
		store: readPersistedSentMessages(persistedPath)
	};
	state.bucketsByPath.set(persistedPath, bucket);
	return bucket;
}
function getSentMessages(cfg) {
	return getSentMessageBucket(cfg).store;
}
function persistSentMessages(bucket) {
	const { store, persistedPath } = bucket;
	const now = Date.now();
	const serialized = {};
	for (const [chatId, entry] of store) {
		cleanupExpired(store, chatId, entry, now);
		if (entry.size > 0) serialized[chatId] = Object.fromEntries(entry);
	}
	if (Object.keys(serialized).length === 0) {
		fs.rmSync(persistedPath, { force: true });
		return;
	}
	replaceFileAtomicSync({
		filePath: persistedPath,
		content: JSON.stringify(serialized),
		tempPrefix: ".telegram-sent-message-cache"
	});
}
function recordSentMessage(chatId, messageId, cfg) {
	const scopeKey = String(chatId);
	const idKey = String(messageId);
	const now = Date.now();
	const bucket = getSentMessageBucket(cfg);
	const { store } = bucket;
	let entry = store.get(scopeKey);
	if (!entry) {
		entry = /* @__PURE__ */ new Map();
		store.set(scopeKey, entry);
	}
	entry.set(idKey, now);
	if (entry.size > 100) cleanupExpired(store, scopeKey, entry, now);
	try {
		persistSentMessages(bucket);
	} catch (error) {
		logVerbose(`telegram: failed to persist sent-message cache: ${String(error)}`);
	}
}
function wasSentByBot(chatId, messageId, cfg) {
	const scopeKey = String(chatId);
	const idKey = String(messageId);
	const store = getSentMessages(cfg);
	const entry = store.get(scopeKey);
	if (!entry) return false;
	cleanupExpired(store, scopeKey, entry, Date.now());
	return entry.has(idKey);
}
//#endregion
//#region extensions/telegram/src/target-writeback.ts
const writebackLogger = createSubsystemLogger("telegram/target-writeback");
const TELEGRAM_ADMIN_SCOPE = "operator.admin";
function asObjectRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value;
}
function normalizeTelegramLookupTargetForMatch(raw) {
	const normalized = normalizeTelegramLookupTarget(raw);
	if (!normalized) return;
	return normalized.startsWith("@") ? normalizeLowercaseStringOrEmpty(normalized) : normalized;
}
function normalizeTelegramTargetForMatch(raw) {
	const parsed = parseTelegramTarget(raw);
	const normalized = normalizeTelegramLookupTargetForMatch(parsed.chatId);
	if (!normalized) return;
	return `${normalized}|${parsed.messageThreadId == null ? "" : String(parsed.messageThreadId)}`;
}
function buildResolvedTelegramTarget(params) {
	const { raw, parsed, resolvedChatId } = params;
	if (parsed.messageThreadId == null) return resolvedChatId;
	return raw.includes(":topic:") ? `${resolvedChatId}:topic:${parsed.messageThreadId}` : `${resolvedChatId}:${parsed.messageThreadId}`;
}
function resolveLegacyRewrite(params) {
	const parsed = parseTelegramTarget(params.raw);
	if (normalizeTelegramChatId(parsed.chatId)) return null;
	const normalized = normalizeTelegramLookupTargetForMatch(parsed.chatId);
	if (!normalized) return null;
	return {
		matchKey: `${normalized}|${parsed.messageThreadId == null ? "" : String(parsed.messageThreadId)}`,
		resolvedTarget: buildResolvedTelegramTarget({
			raw: params.raw,
			parsed,
			resolvedChatId: params.resolvedChatId
		})
	};
}
function rewriteTargetIfMatch(params) {
	if (typeof params.rawValue !== "string" && typeof params.rawValue !== "number") return null;
	const value = normalizeOptionalString(String(params.rawValue)) ?? "";
	if (!value) return null;
	if (normalizeTelegramTargetForMatch(value) !== params.matchKey) return null;
	return params.resolvedTarget;
}
function replaceTelegramDefaultToTargets(params) {
	let changed = false;
	const telegram = asObjectRecord(params.cfg.channels?.telegram);
	if (!telegram) return changed;
	const maybeReplace = (holder, key) => {
		const nextTarget = rewriteTargetIfMatch({
			rawValue: holder[key],
			matchKey: params.matchKey,
			resolvedTarget: params.resolvedTarget
		});
		if (!nextTarget) return;
		holder[key] = nextTarget;
		changed = true;
	};
	maybeReplace(telegram, "defaultTo");
	const accounts = asObjectRecord(telegram.accounts);
	if (!accounts) return changed;
	for (const accountId of Object.keys(accounts)) {
		const account = asObjectRecord(accounts[accountId]);
		if (!account) continue;
		maybeReplace(account, "defaultTo");
	}
	return changed;
}
async function maybePersistResolvedTelegramTarget(params) {
	const raw = params.rawTarget.trim();
	if (!raw) return;
	const rewrite = resolveLegacyRewrite({
		raw,
		resolvedChatId: params.resolvedChatId
	});
	if (!rewrite) return;
	const { matchKey, resolvedTarget } = rewrite;
	if (Array.isArray(params.gatewayClientScopes) && !params.gatewayClientScopes.includes(TELEGRAM_ADMIN_SCOPE)) {
		writebackLogger.warn(`skipping Telegram target writeback for ${raw} because gateway caller is missing ${TELEGRAM_ADMIN_SCOPE}`);
		return;
	}
	try {
		const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
		const nextConfig = structuredClone(snapshot.config ?? {});
		if (replaceTelegramDefaultToTargets({
			cfg: nextConfig,
			matchKey,
			resolvedTarget
		})) {
			await replaceConfigFile({
				nextConfig,
				snapshot,
				writeOptions,
				afterWrite: { mode: "auto" }
			});
			if (params.verbose) writebackLogger.warn(`resolved Telegram defaultTo target ${raw} -> ${resolvedTarget}`);
		}
	} catch (err) {
		if (params.verbose) writebackLogger.warn(`failed to persist Telegram defaultTo target ${raw}: ${String(err)}`);
	}
	try {
		const storePath = resolveCronStorePath(params.cfg.cron?.store);
		const store = await loadCronStore(storePath);
		let cronChanged = false;
		for (const job of store.jobs) {
			if (job.delivery?.channel !== "telegram") continue;
			const nextTarget = rewriteTargetIfMatch({
				rawValue: job.delivery.to,
				matchKey,
				resolvedTarget
			});
			if (!nextTarget) continue;
			job.delivery.to = nextTarget;
			cronChanged = true;
		}
		if (cronChanged) {
			await saveCronStore(storePath, store);
			if (params.verbose) writebackLogger.warn(`resolved Telegram cron delivery target ${raw} -> ${resolvedTarget}`);
		}
	} catch (err) {
		if (params.verbose) writebackLogger.warn(`failed to persist Telegram cron target ${raw}: ${String(err)}`);
	}
}
//#endregion
//#region extensions/telegram/src/voice.ts
function resolveTelegramVoiceDecision(opts) {
	if (!opts.wantsVoice) return { useVoice: false };
	if (isVoiceCompatibleAudio(opts)) return { useVoice: true };
	return {
		useVoice: false,
		reason: `media is ${opts.contentType ?? "unknown"} (${opts.fileName ?? "unknown"})`
	};
}
function resolveTelegramVoiceSend(opts) {
	const decision = resolveTelegramVoiceDecision(opts);
	if (decision.reason && opts.logFallback) opts.logFallback(`Telegram voice requested but ${decision.reason}; sending as audio file instead.`);
	return { useVoice: decision.useVoice };
}
//#endregion
//#region extensions/telegram/src/send.ts
const InputFileCtor = grammy.InputFile;
const MAX_TELEGRAM_PHOTO_DIMENSION_SUM = 1e4;
const MAX_TELEGRAM_PHOTO_ASPECT_RATIO = 20;
function resolveTelegramMessageIdOrThrow(result, context) {
	if (typeof result?.message_id === "number" && Number.isFinite(result.message_id)) return Math.trunc(result.message_id);
	throw new Error(`Telegram ${context} returned no message_id`);
}
function splitTelegramPlainTextChunks(text, limit) {
	if (!text) return [];
	const normalizedLimit = Math.max(1, Math.floor(limit));
	const chunks = [];
	for (let start = 0; start < text.length; start += normalizedLimit) chunks.push(text.slice(start, start + normalizedLimit));
	return chunks;
}
function splitTelegramPlainTextFallback(text, chunkCount, limit) {
	if (!text) return [];
	const normalizedLimit = Math.max(1, Math.floor(limit));
	const fixedChunks = splitTelegramPlainTextChunks(text, normalizedLimit);
	if (chunkCount <= 1 || fixedChunks.length >= chunkCount) return fixedChunks;
	const chunks = [];
	let offset = 0;
	for (let index = 0; index < chunkCount; index += 1) {
		const remainingChars = text.length - offset;
		const remainingChunks = chunkCount - index;
		const nextChunkLength = remainingChunks === 1 ? remainingChars : Math.min(normalizedLimit, Math.ceil(remainingChars / remainingChunks));
		chunks.push(text.slice(offset, offset + nextChunkLength));
		offset += nextChunkLength;
	}
	return chunks;
}
function logTelegramOutboundSendOk(params) {
	const parts = [
		"telegram outbound send ok",
		`accountId=${params.accountId}`,
		`chatId=${params.chatId}`,
		`messageId=${params.messageId}`,
		`operation=${params.operation}`
	];
	if (params.deliveryKind) parts.push(`deliveryKind=${params.deliveryKind}`);
	if (typeof params.messageThreadId === "number") parts.push(`threadId=${params.messageThreadId}`);
	if (typeof params.replyToMessageId === "number") parts.push(`replyToMessageId=${params.replyToMessageId}`);
	if (params.silent === true) parts.push("silent=true");
	if (typeof params.chunkCount === "number") parts.push(`chunkCount=${params.chunkCount}`);
	sendLogger.info(parts.join(" "));
}
const PARSE_ERR_RE = /can't parse entities|parse entities|find end of the entity/i;
const MESSAGE_NOT_MODIFIED_RE = /400:\s*Bad Request:\s*message is not modified|MESSAGE_NOT_MODIFIED/i;
const MESSAGE_DELETE_NOOP_RE = /message to delete not found|message can't be deleted|MESSAGE_ID_INVALID|MESSAGE_DELETE_FORBIDDEN/i;
const CHAT_NOT_FOUND_RE = /400: Bad Request: chat not found/i;
const sendLogger = createSubsystemLogger("telegram/send");
const diagLogger = createSubsystemLogger("telegram/diagnostic");
const telegramClientOptionsCache = /* @__PURE__ */ new Map();
const MAX_TELEGRAM_CLIENT_OPTIONS_CACHE_SIZE = 64;
function resetTelegramClientOptionsCacheForTests() {
	telegramClientOptionsCache.clear();
}
function createTelegramHttpLogger(cfg) {
	if (!isDiagnosticFlagEnabled("telegram.http", cfg)) return () => {};
	return (label, err) => {
		if (!(err instanceof HttpError)) return;
		const detail = redactSensitiveText(formatUncaughtError(err.error ?? err));
		diagLogger.warn(`telegram http error (${label}): ${detail}`);
	};
}
function shouldUseTelegramClientOptionsCache() {
	return !process.env.VITEST && true;
}
function buildTelegramClientOptionsCacheKey(params) {
	const proxyKey = params.account.config.proxy?.trim() ?? "";
	const autoSelectFamily = params.account.config.network?.autoSelectFamily;
	const autoSelectFamilyKey = typeof autoSelectFamily === "boolean" ? String(autoSelectFamily) : "default";
	const dnsResultOrderKey = params.account.config.network?.dnsResultOrder ?? "default";
	const apiRootKey = params.account.config.apiRoot?.trim() ?? "";
	const timeoutSecondsKey = typeof params.timeoutSeconds === "number" ? String(params.timeoutSeconds) : "default";
	return `${params.account.accountId}::${proxyKey}::${autoSelectFamilyKey}::${dnsResultOrderKey}::${apiRootKey}::${timeoutSecondsKey}`;
}
function setCachedTelegramClientOptions(cacheKey, clientOptions) {
	telegramClientOptionsCache.set(cacheKey, clientOptions);
	if (telegramClientOptionsCache.size > MAX_TELEGRAM_CLIENT_OPTIONS_CACHE_SIZE) {
		const oldestKey = telegramClientOptionsCache.keys().next().value;
		if (oldestKey !== void 0) telegramClientOptionsCache.delete(oldestKey);
	}
	return clientOptions;
}
function resolveTelegramClientOptions(account) {
	const timeoutSeconds = typeof account.config.timeoutSeconds === "number" && Number.isFinite(account.config.timeoutSeconds) ? Math.max(1, Math.floor(account.config.timeoutSeconds)) : void 0;
	const cacheKey = shouldUseTelegramClientOptionsCache() ? buildTelegramClientOptionsCacheKey({
		account,
		timeoutSeconds
	}) : null;
	if (cacheKey && telegramClientOptionsCache.has(cacheKey)) return telegramClientOptionsCache.get(cacheKey);
	const proxyUrl = normalizeOptionalString(account.config.proxy);
	const proxyFetch = proxyUrl ? makeProxyFetch(proxyUrl) : void 0;
	const apiRoot = normalizeOptionalString(account.config.apiRoot);
	const normalizedApiRoot = apiRoot ? normalizeTelegramApiRoot(apiRoot) : void 0;
	const transport = resolveTelegramTransport(proxyFetch, { network: account.config.network });
	const fetchImpl = createTelegramClientFetch({
		fetchImpl: asTelegramClientFetch(transport.fetch),
		timeoutSeconds,
		transport
	});
	const clientOptions = fetchImpl || timeoutSeconds || normalizedApiRoot ? {
		...fetchImpl ? { fetch: asTelegramClientFetch(fetchImpl) } : {},
		...timeoutSeconds ? { timeoutSeconds } : {},
		...normalizedApiRoot ? { apiRoot: normalizedApiRoot } : {}
	} : void 0;
	if (cacheKey) return setCachedTelegramClientOptions(cacheKey, clientOptions);
	return clientOptions;
}
function resolveToken(explicit, params) {
	if (explicit?.trim()) return explicit.trim();
	if (!params.token) throw new Error(`Telegram bot token missing for account "${params.accountId}" (set channels.telegram.accounts.${params.accountId}.botToken/tokenFile or TELEGRAM_BOT_TOKEN for default).`);
	return params.token.trim();
}
async function resolveChatId(to, params) {
	const numericChatId = normalizeTelegramChatId(to);
	if (numericChatId) return numericChatId;
	const lookupTarget = normalizeTelegramLookupTarget(to);
	const getChat = params.api.getChat;
	if (!lookupTarget || typeof getChat !== "function") throw new Error("Telegram recipient must be a numeric chat ID");
	try {
		const chat = await getChat.call(params.api, lookupTarget);
		const resolved = normalizeTelegramChatId(String(chat?.id ?? ""));
		if (!resolved) throw new Error(`resolved chat id is not numeric (${String(chat?.id ?? "")})`);
		if (params.verbose) sendLogger.warn(`telegram recipient ${lookupTarget} resolved to numeric chat id ${resolved}`);
		return resolved;
	} catch (err) {
		const detail = formatErrorMessage(err);
		throw new Error(`Telegram recipient ${lookupTarget} could not be resolved to a numeric chat ID (${detail})`, { cause: err });
	}
}
async function resolveAndPersistChatId(params) {
	const chatId = await resolveChatId(params.lookupTarget, {
		api: params.api,
		verbose: params.verbose
	});
	await maybePersistResolvedTelegramTarget({
		cfg: params.cfg,
		rawTarget: params.persistTarget,
		resolvedChatId: chatId,
		verbose: params.verbose,
		gatewayClientScopes: params.gatewayClientScopes
	});
	return chatId;
}
function normalizeMessageId(raw) {
	if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
	if (typeof raw === "string") {
		const value = raw.trim();
		if (!value) throw new Error("Message id is required for Telegram actions");
		const parsed = Number.parseInt(value, 10);
		if (Number.isFinite(parsed)) return parsed;
	}
	throw new Error("Message id is required for Telegram actions");
}
function isTelegramMessageNotModifiedError(err) {
	return MESSAGE_NOT_MODIFIED_RE.test(formatErrorMessage(err));
}
function isTelegramMessageDeleteNoopError(err) {
	return MESSAGE_DELETE_NOOP_RE.test(formatErrorMessage(err));
}
function isTelegramHtmlParseError(err) {
	return PARSE_ERR_RE.test(formatErrorMessage(err));
}
async function withTelegramHtmlParseFallback(params) {
	try {
		return await params.requestHtml(params.label);
	} catch (err) {
		if (!isTelegramHtmlParseError(err)) throw err;
		if (params.verbose) sendLogger.warn(`telegram ${params.label} failed with HTML parse error, retrying as plain text: ${formatErrorMessage(err)}`);
		return await params.requestPlain(`${params.label}-plain`);
	}
}
function resolveTelegramApiContext(opts) {
	const cfg = requireRuntimeConfig(opts.cfg, "Telegram API context");
	const account = resolveTelegramAccount({
		cfg,
		accountId: opts.accountId
	});
	const token = resolveToken(opts.token, account);
	const client = resolveTelegramClientOptions(account);
	let api;
	if (opts.api) api = opts.api;
	else {
		const bot = new Bot(token, client ? { client } : void 0);
		bot.api.config.use(getOrCreateAccountThrottler(token));
		api = bot.api;
	}
	return {
		cfg,
		account,
		api
	};
}
function createTelegramRequestWithDiag(params) {
	const request = createChannelApiRetryRunner({
		retry: params.retry,
		configRetry: params.account.config.retry,
		verbose: params.verbose,
		...params.shouldRetry ? { shouldRetry: params.shouldRetry } : {},
		...params.strictShouldRetry ? { strictShouldRetry: true } : {}
	});
	const logHttpError = createTelegramHttpLogger(params.cfg);
	return (fn, label, options) => {
		const runRequest = () => request(fn, label);
		return (params.useApiErrorLogging === false ? runRequest() : withTelegramApiErrorLogging({
			operation: label ?? "request",
			fn: runRequest,
			...options?.shouldLog ? { shouldLog: options.shouldLog } : {}
		})).catch((err) => {
			logHttpError(label ?? "request", err);
			throw err;
		});
	};
}
function wrapTelegramChatNotFoundError(err, params) {
	const errorMsg = formatErrorMessage(err);
	if (/403.*(bot.*not.*member|bot.*blocked|bot.*kicked)/i.test(errorMsg)) return new Error([
		`Telegram send failed: bot is not a member of the chat, was blocked, or was kicked (chat_id=${params.chatId}).`,
		`Telegram API said: ${errorMsg}.`,
		"Fix: Add the bot to the channel/group, or ensure it has not been removed/blocked/kicked by the user.",
		`Input was: ${JSON.stringify(params.input)}.`
	].join(" "));
	if (!CHAT_NOT_FOUND_RE.test(errorMsg)) return err;
	return new Error([
		`Telegram send failed: chat not found (chat_id=${params.chatId}).`,
		"Likely: bot not started in DM, bot removed from group/channel, group migrated (new -100… id), or wrong bot token.",
		`Input was: ${JSON.stringify(params.input)}.`
	].join(" "));
}
function createRequestWithChatNotFound(params) {
	return async (fn, label) => params.requestWithDiag(fn, label).catch((err) => {
		throw wrapTelegramChatNotFoundError(err, {
			chatId: params.chatId,
			input: params.input
		});
	});
}
function createTelegramNonIdempotentRequestWithDiag(params) {
	return createTelegramRequestWithDiag({
		cfg: params.cfg,
		account: params.account,
		retry: params.retry,
		verbose: params.verbose,
		useApiErrorLogging: params.useApiErrorLogging,
		shouldRetry: (err) => isSafeToRetrySendError(err) || isTelegramRateLimitError(err),
		strictShouldRetry: true
	});
}
async function sendMessageTelegram(to, text, opts) {
	const { cfg, account, api } = resolveTelegramApiContext(opts);
	const target = parseTelegramTarget(to);
	const chatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: target.chatId,
		persistTarget: to,
		verbose: opts.verbose,
		gatewayClientScopes: opts.gatewayClientScopes
	});
	const mediaUrl = opts.mediaUrl?.trim();
	const mediaMaxBytes = opts.maxBytes ?? (typeof account.config.mediaMaxMb === "number" ? account.config.mediaMaxMb : 100) * 1024 * 1024;
	const replyMarkup = buildInlineKeyboard(opts.buttons);
	const threadParams = buildTelegramThreadReplyParams({
		thread: resolveTelegramSendThreadSpec({
			targetMessageThreadId: target.messageThreadId,
			messageThreadId: opts.messageThreadId,
			chatType: target.chatType
		}),
		replyToMessageId: opts.replyToMessageId,
		replyQuoteText: opts.quoteText,
		useReplyIdAsQuoteSource: true
	});
	const hasThreadParams = Object.keys(threadParams).length > 0;
	const requestWithChatNotFound = createRequestWithChatNotFound({
		requestWithDiag: createTelegramNonIdempotentRequestWithDiag({
			cfg,
			account,
			retry: opts.retry,
			verbose: opts.verbose
		}),
		chatId,
		input: to
	});
	const textMode = opts.textMode ?? "markdown";
	const tableMode = resolveMarkdownTableMode({
		cfg,
		channel: "telegram",
		accountId: account.accountId
	});
	const renderHtmlText = (value) => renderTelegramHtmlText(value, {
		textMode,
		tableMode
	});
	const linkPreviewOptions = account.config.linkPreview ?? true ? void 0 : { is_disabled: true };
	const sendTelegramTextChunk = async (chunk, params) => {
		const baseParams = params ? { ...params } : {};
		if (linkPreviewOptions) baseParams.link_preview_options = linkPreviewOptions;
		const plainParams = {
			...baseParams,
			...opts.silent === true ? { disable_notification: true } : {}
		};
		const hasPlainParams = Object.keys(plainParams).length > 0;
		const requestPlain = (label) => requestWithChatNotFound(() => hasPlainParams ? api.sendMessage(chatId, chunk.plainText, plainParams) : api.sendMessage(chatId, chunk.plainText), label);
		return {
			result: !chunk.htmlText ? await requestPlain("message") : await withTelegramHtmlParseFallback({
				label: "message",
				verbose: opts.verbose,
				requestHtml: (label) => requestWithChatNotFound(() => api.sendMessage(chatId, chunk.htmlText ?? chunk.plainText, {
					parse_mode: "HTML",
					...plainParams
				}), label),
				requestPlain
			}),
			acceptedParams: params
		};
	};
	const buildTextParams = (isLastChunk) => hasThreadParams || isLastChunk && replyMarkup ? {
		...threadParams,
		...isLastChunk && replyMarkup ? { reply_markup: replyMarkup } : {}
	} : void 0;
	const sendTelegramTextChunks = async (chunks, context) => {
		let lastMessageId = "";
		let lastChatId = chatId;
		let lastAcceptedParams;
		let sentChunkCount = 0;
		for (let index = 0; index < chunks.length; index += 1) {
			const chunk = chunks[index];
			if (!chunk) continue;
			const { result: res, acceptedParams } = await sendTelegramTextChunk(chunk, buildTextParams(index === chunks.length - 1));
			const messageId = resolveTelegramMessageIdOrThrow(res, context);
			recordSentMessage(chatId, messageId, cfg);
			lastMessageId = String(messageId);
			lastChatId = String(res?.chat?.id ?? chatId);
			lastAcceptedParams = acceptedParams;
			sentChunkCount += 1;
		}
		if (lastMessageId) logTelegramOutboundSendOk({
			accountId: account.accountId,
			chatId: lastChatId,
			messageId: lastMessageId,
			operation: "sendMessage",
			deliveryKind: "text",
			messageThreadId: lastAcceptedParams?.message_thread_id,
			replyToMessageId: opts.replyToMessageId,
			silent: opts.silent,
			chunkCount: sentChunkCount
		});
		return {
			messageId: lastMessageId,
			chatId: lastChatId
		};
	};
	const buildChunkedTextPlan = (rawText, context) => {
		const htmlText = renderHtmlText(rawText);
		const fallbackText = opts.plainText ?? (textMode === "html" ? telegramHtmlToPlainTextFallback(htmlText) : rawText);
		let htmlChunks;
		try {
			htmlChunks = splitTelegramHtmlChunks(htmlText, 4e3);
		} catch (error) {
			logVerbose(`telegram ${context} failed HTML chunk planning, retrying as plain text: ${formatErrorMessage(error)}`);
			return splitTelegramPlainTextChunks(fallbackText, 4e3).map((plainText) => ({ plainText }));
		}
		const fixedPlainTextChunks = splitTelegramPlainTextChunks(fallbackText, 4e3);
		if (fixedPlainTextChunks.length > htmlChunks.length) {
			logVerbose(`telegram ${context} plain-text fallback needs more chunks than HTML; sending plain text`);
			return fixedPlainTextChunks.map((plainText) => ({ plainText }));
		}
		const plainTextChunks = splitTelegramPlainTextFallback(fallbackText, htmlChunks.length, 4e3);
		return htmlChunks.map((htmlText, index) => ({
			htmlText,
			plainText: plainTextChunks[index] ?? htmlText
		}));
	};
	const sendChunkedText = async (rawText, context) => await sendTelegramTextChunks(buildChunkedTextPlan(rawText, context), context);
	async function shouldSendTelegramImageAsPhoto(buffer) {
		try {
			const metadata = await getImageMetadata(buffer);
			const width = metadata?.width;
			const height = metadata?.height;
			if (typeof width !== "number" || typeof height !== "number") {
				sendLogger.warn("Photo dimensions are unavailable. Sending as document instead.");
				return false;
			}
			const shorterSide = Math.min(width, height);
			const longerSide = Math.max(width, height);
			if (!(width + height <= MAX_TELEGRAM_PHOTO_DIMENSION_SUM && shorterSide > 0 && longerSide <= shorterSide * MAX_TELEGRAM_PHOTO_ASPECT_RATIO)) {
				sendLogger.warn(`Photo dimensions (${width}x${height}) are not valid for Telegram photos. Sending as document instead.`);
				return false;
			}
			return true;
		} catch (err) {
			sendLogger.warn(`Failed to validate photo dimensions: ${formatErrorMessage(err)}. Sending as document instead.`);
			return false;
		}
	}
	if (mediaUrl) {
		const media = await loadWebMedia(mediaUrl, buildOutboundMediaLoadOptions({
			maxBytes: mediaMaxBytes,
			mediaLocalRoots: opts.mediaLocalRoots,
			mediaReadFile: opts.mediaReadFile,
			optimizeImages: opts.forceDocument ? false : void 0
		}));
		const kind = kindFromMime(media.contentType ?? void 0);
		const isGif = isGifMedia({
			contentType: media.contentType,
			fileName: media.fileName
		});
		let sendImageAsPhoto = true;
		const deliveryKind = opts.forceDocument === true && (kind === "image" || kind === "video") ? "document" : kind;
		if (deliveryKind === "image" && !isGif) sendImageAsPhoto = await shouldSendTelegramImageAsPhoto(media.buffer);
		const isVideoNote = deliveryKind === "video" && opts.asVideoNote === true;
		const fileName = media.fileName ?? (isGif ? "animation.gif" : inferFilename(kind ?? "document")) ?? "file";
		const file = new InputFileCtor(media.buffer, fileName);
		let caption;
		let followUpText;
		if (isVideoNote) {
			caption = void 0;
			followUpText = text.trim() ? text : void 0;
		} else {
			const split = splitTelegramCaption(text);
			caption = split.caption;
			followUpText = split.followUpText;
		}
		const htmlCaption = caption ? renderHtmlText(caption) : void 0;
		const needsSeparateText = Boolean(followUpText);
		const baseMediaParams = {
			...hasThreadParams ? threadParams : {},
			...!needsSeparateText && replyMarkup ? { reply_markup: replyMarkup } : {}
		};
		const videoDimensions = deliveryKind === "video" && !isVideoNote ? await probeVideoDimensions(media.buffer) : void 0;
		const mediaParams = {
			...htmlCaption ? {
				caption: htmlCaption,
				parse_mode: "HTML"
			} : {},
			...baseMediaParams,
			...opts.silent === true ? { disable_notification: true } : {},
			...videoDimensions ? {
				width: videoDimensions.width,
				height: videoDimensions.height
			} : {}
		};
		const sendMedia = async (label, sender) => await requestWithChatNotFound(() => sender(mediaParams), label);
		const mediaSender = (() => {
			if (isGif && deliveryKind !== "document") return {
				label: "animation",
				sender: (effectiveParams) => api.sendAnimation(chatId, file, effectiveParams)
			};
			if (deliveryKind === "image" && !isGif && sendImageAsPhoto) return {
				label: "photo",
				sender: (effectiveParams) => api.sendPhoto(chatId, file, effectiveParams)
			};
			if (deliveryKind === "video") {
				if (isVideoNote) return {
					label: "video_note",
					sender: (effectiveParams) => api.sendVideoNote(chatId, file, effectiveParams)
				};
				return {
					label: "video",
					sender: (effectiveParams) => api.sendVideo(chatId, file, effectiveParams)
				};
			}
			if (kind === "audio") {
				const { useVoice } = resolveTelegramVoiceSend({
					wantsVoice: opts.asVoice === true,
					contentType: media.contentType,
					fileName,
					logFallback: logVerbose
				});
				if (useVoice) return {
					label: "voice",
					sender: (effectiveParams) => api.sendVoice(chatId, file, effectiveParams)
				};
				return {
					label: "audio",
					sender: (effectiveParams) => api.sendAudio(chatId, file, effectiveParams)
				};
			}
			return {
				label: "document",
				sender: (effectiveParams) => api.sendDocument(chatId, file, opts.forceDocument ? {
					...effectiveParams,
					disable_content_type_detection: true
				} : effectiveParams)
			};
		})();
		const result = await sendMedia(mediaSender.label, mediaSender.sender);
		const mediaMessageId = resolveTelegramMessageIdOrThrow(result, "media send");
		const resolvedChatId = String(result?.chat?.id ?? chatId);
		recordSentMessage(chatId, mediaMessageId, cfg);
		logTelegramOutboundSendOk({
			accountId: account.accountId,
			chatId: resolvedChatId,
			messageId: String(mediaMessageId),
			operation: `send${mediaSender.label.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("")}`,
			deliveryKind: mediaSender.label,
			messageThreadId: mediaParams.message_thread_id,
			replyToMessageId: opts.replyToMessageId,
			silent: opts.silent
		});
		recordChannelActivity({
			channel: "telegram",
			accountId: account.accountId,
			direction: "outbound"
		});
		if (needsSeparateText && followUpText) return {
			messageId: (await sendChunkedText(followUpText, "text follow-up send")).messageId,
			chatId: resolvedChatId
		};
		return {
			messageId: String(mediaMessageId),
			chatId: resolvedChatId
		};
	}
	if (!text || !text.trim()) throw new Error("Message must be non-empty for Telegram sends");
	const textResult = await sendChunkedText(text, "text send");
	recordChannelActivity({
		channel: "telegram",
		accountId: account.accountId,
		direction: "outbound"
	});
	return textResult;
}
async function sendTypingTelegram(to, opts) {
	const { cfg, account, api } = resolveTelegramApiContext(opts);
	const target = parseTelegramTarget(to);
	const chatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: target.chatId,
		persistTarget: to,
		verbose: opts.verbose
	});
	const requestWithDiag = createTelegramRequestWithDiag({
		cfg,
		account,
		retry: opts.retry,
		verbose: opts.verbose,
		shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "send" })
	});
	const threadParams = buildTypingThreadParams(target.messageThreadId ?? opts.messageThreadId);
	await requestWithDiag(() => api.sendChatAction(chatId, "typing", threadParams), "typing");
	return { ok: true };
}
async function reactMessageTelegram(chatIdInput, messageIdInput, emoji, opts) {
	const { cfg, account, api } = resolveTelegramApiContext(opts);
	const rawTarget = String(chatIdInput);
	const chatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: rawTarget,
		persistTarget: rawTarget,
		verbose: opts.verbose,
		gatewayClientScopes: opts.gatewayClientScopes
	});
	const messageId = normalizeMessageId(messageIdInput);
	const requestWithDiag = createTelegramRequestWithDiag({
		cfg,
		account,
		retry: opts.retry,
		verbose: opts.verbose,
		shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "send" })
	});
	const remove = opts.remove === true;
	const trimmedEmoji = emoji.trim();
	const reactions = remove || !trimmedEmoji ? [] : [{
		type: "emoji",
		emoji: trimmedEmoji
	}];
	if (typeof api.setMessageReaction !== "function") throw new Error("Telegram reactions are unavailable in this bot API.");
	try {
		await requestWithDiag(() => api.setMessageReaction(chatId, messageId, reactions), "reaction");
	} catch (err) {
		const msg = formatErrorMessage(err);
		if (/REACTION_INVALID/i.test(msg)) return {
			ok: false,
			warning: `Reaction unavailable: ${trimmedEmoji}`
		};
		throw err;
	}
	return { ok: true };
}
async function deleteMessageTelegram(chatIdInput, messageIdInput, opts) {
	const { cfg, account, api } = resolveTelegramApiContext(opts);
	const rawTarget = String(chatIdInput);
	const chatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: rawTarget,
		persistTarget: rawTarget,
		verbose: opts.verbose,
		gatewayClientScopes: opts.gatewayClientScopes
	});
	const messageId = normalizeMessageId(messageIdInput);
	const requestWithDiag = createTelegramRequestWithDiag({
		cfg,
		account,
		retry: opts.retry,
		verbose: opts.verbose,
		shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { context: "send" })
	});
	try {
		await requestWithDiag(() => api.deleteMessage(chatId, messageId), "deleteMessage", { shouldLog: (err) => !isTelegramMessageDeleteNoopError(err) });
	} catch (err) {
		if (!isTelegramMessageDeleteNoopError(err)) throw err;
		const detail = formatErrorMessage(err);
		logVerbose(`[telegram] Delete skipped for message ${messageId} in chat ${chatId}: ${detail}`);
		return {
			ok: false,
			warning: `Message ${messageId} was not deleted: ${detail}`
		};
	}
	logVerbose(`[telegram] Deleted message ${messageId} from chat ${chatId}`);
	return { ok: true };
}
async function pinMessageTelegram(chatIdInput, messageIdInput, opts) {
	const { cfg, account, api } = resolveTelegramApiContext(opts);
	const rawTarget = String(chatIdInput);
	const chatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: rawTarget,
		persistTarget: rawTarget,
		verbose: opts.verbose,
		gatewayClientScopes: opts.gatewayClientScopes
	});
	const messageId = normalizeMessageId(messageIdInput);
	await createTelegramRequestWithDiag({
		cfg,
		account,
		retry: opts.retry,
		verbose: opts.verbose
	})(() => api.pinChatMessage(chatId, messageId, { disable_notification: opts.notify !== true }), "pinChatMessage");
	logVerbose(`[telegram] Pinned message ${messageId} in chat ${chatId}`);
	return {
		ok: true,
		messageId: String(messageId),
		chatId
	};
}
async function unpinMessageTelegram(chatIdInput, messageIdInput, opts) {
	const { cfg, account, api } = resolveTelegramApiContext(opts);
	const rawTarget = String(chatIdInput);
	const chatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: rawTarget,
		persistTarget: rawTarget,
		verbose: opts.verbose,
		gatewayClientScopes: opts.gatewayClientScopes
	});
	const messageId = messageIdInput === void 0 ? void 0 : normalizeMessageId(messageIdInput);
	await createTelegramRequestWithDiag({
		cfg,
		account,
		retry: opts.retry,
		verbose: opts.verbose
	})(() => api.unpinChatMessage(chatId, messageId), "unpinChatMessage");
	logVerbose(`[telegram] Unpinned ${messageId != null ? `message ${messageId}` : "active message"} in chat ${chatId}`);
	return {
		ok: true,
		chatId,
		...messageId != null ? { messageId: String(messageId) } : {}
	};
}
async function editForumTopicTelegram(chatIdInput, messageThreadIdInput, opts) {
	const nameProvided = opts.name !== void 0;
	const trimmedName = opts.name?.trim();
	if (nameProvided && !trimmedName) throw new Error("Telegram forum topic name is required");
	if (trimmedName && trimmedName.length > 128) throw new Error("Telegram forum topic name must be 128 characters or fewer");
	const iconProvided = opts.iconCustomEmojiId !== void 0;
	const trimmedIconCustomEmojiId = opts.iconCustomEmojiId?.trim();
	if (iconProvided && !trimmedIconCustomEmojiId) throw new Error("Telegram forum topic icon custom emoji ID is required");
	if (!trimmedName && !trimmedIconCustomEmojiId) throw new Error("Telegram forum topic update requires a name or iconCustomEmojiId");
	const { cfg, account, api } = resolveTelegramApiContext(opts);
	const rawTarget = String(chatIdInput);
	const chatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: parseTelegramTarget(rawTarget).chatId,
		persistTarget: rawTarget,
		verbose: opts.verbose,
		gatewayClientScopes: opts.gatewayClientScopes
	});
	const messageThreadId = normalizeMessageId(messageThreadIdInput);
	const requestWithDiag = createTelegramRequestWithDiag({
		cfg,
		account,
		retry: opts.retry,
		verbose: opts.verbose
	});
	const payload = {
		...trimmedName ? { name: trimmedName } : {},
		...trimmedIconCustomEmojiId ? { icon_custom_emoji_id: trimmedIconCustomEmojiId } : {}
	};
	await requestWithDiag(() => api.editForumTopic(chatId, messageThreadId, payload), "editForumTopic");
	logVerbose(`[telegram] Edited forum topic ${messageThreadId} in chat ${chatId}`);
	return {
		ok: true,
		chatId,
		messageThreadId,
		...trimmedName ? { name: trimmedName } : {},
		...trimmedIconCustomEmojiId ? { iconCustomEmojiId: trimmedIconCustomEmojiId } : {}
	};
}
async function renameForumTopicTelegram(chatIdInput, messageThreadIdInput, name, opts) {
	const result = await editForumTopicTelegram(chatIdInput, messageThreadIdInput, {
		...opts,
		name
	});
	return {
		ok: true,
		chatId: result.chatId,
		messageThreadId: result.messageThreadId,
		name: result.name ?? name.trim()
	};
}
async function editMessageReplyMarkupTelegram(chatIdInput, messageIdInput, buttons, opts) {
	const { cfg, account, api } = resolveTelegramApiContext({
		...opts,
		cfg: opts.cfg
	});
	const rawTarget = String(chatIdInput);
	const chatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: rawTarget,
		persistTarget: rawTarget,
		verbose: opts.verbose,
		gatewayClientScopes: opts.gatewayClientScopes
	});
	const messageId = normalizeMessageId(messageIdInput);
	const requestWithDiag = createTelegramRequestWithDiag({
		cfg,
		account,
		retry: opts.retry,
		verbose: opts.verbose
	});
	const replyMarkup = buildInlineKeyboard(buttons) ?? { inline_keyboard: [] };
	try {
		await requestWithDiag(() => api.editMessageReplyMarkup(chatId, messageId, { reply_markup: replyMarkup }), "editMessageReplyMarkup", { shouldLog: (err) => !isTelegramMessageNotModifiedError(err) });
	} catch (err) {
		if (!isTelegramMessageNotModifiedError(err)) throw err;
	}
	logVerbose(`[telegram] Edited reply markup for message ${messageId} in chat ${chatId}`);
	return {
		ok: true,
		messageId: String(messageId),
		chatId
	};
}
async function editMessageTelegram(chatIdInput, messageIdInput, text, opts) {
	const { cfg, account, api } = resolveTelegramApiContext({
		...opts,
		cfg: opts.cfg
	});
	const rawTarget = String(chatIdInput);
	const chatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: rawTarget,
		persistTarget: rawTarget,
		verbose: opts.verbose,
		gatewayClientScopes: opts.gatewayClientScopes
	});
	const messageId = normalizeMessageId(messageIdInput);
	const requestWithDiag = createTelegramRequestWithDiag({
		cfg,
		account,
		retry: opts.retry,
		verbose: opts.verbose,
		shouldRetry: (err) => isRecoverableTelegramNetworkError(err, { allowMessageMatch: true }) || isTelegramServerError(err)
	});
	const requestWithEditShouldLog = (fn, label, shouldLog) => requestWithDiag(fn, label, shouldLog ? { shouldLog } : void 0);
	const textMode = opts.textMode ?? "markdown";
	const htmlText = renderTelegramHtmlText(text, {
		textMode,
		tableMode: resolveMarkdownTableMode({
			cfg,
			channel: "telegram",
			accountId: account.accountId
		})
	});
	const plainText = textMode === "html" ? telegramHtmlToPlainTextFallback(htmlText) : text;
	const shouldTouchButtons = opts.buttons !== void 0;
	const builtKeyboard = shouldTouchButtons ? buildInlineKeyboard(opts.buttons) : void 0;
	const replyMarkup = shouldTouchButtons ? builtKeyboard ?? { inline_keyboard: [] } : void 0;
	const editParams = { parse_mode: "HTML" };
	if (opts.linkPreview === false) editParams.link_preview_options = { is_disabled: true };
	if (replyMarkup !== void 0) editParams.reply_markup = replyMarkup;
	const plainParams = {};
	if (opts.linkPreview === false) plainParams.link_preview_options = { is_disabled: true };
	if (replyMarkup !== void 0) plainParams.reply_markup = replyMarkup;
	try {
		await withTelegramHtmlParseFallback({
			label: "editMessage",
			verbose: opts.verbose,
			requestHtml: (retryLabel) => requestWithEditShouldLog(() => api.editMessageText(chatId, messageId, htmlText, editParams), retryLabel, (err) => !isTelegramMessageNotModifiedError(err)),
			requestPlain: (retryLabel) => requestWithEditShouldLog(() => Object.keys(plainParams).length > 0 ? api.editMessageText(chatId, messageId, plainText, plainParams) : api.editMessageText(chatId, messageId, plainText), retryLabel, (plainErr) => !isTelegramMessageNotModifiedError(plainErr))
		});
	} catch (err) {
		if (isTelegramMessageNotModifiedError(err)) {} else throw err;
	}
	logVerbose(`[telegram] Edited message ${messageId} in chat ${chatId}`);
	return {
		ok: true,
		messageId: String(messageId),
		chatId
	};
}
function inferFilename(kind) {
	switch (kind) {
		case "image": return "image.jpg";
		case "video": return "video.mp4";
		case "audio": return "audio.ogg";
		default: return "file.bin";
	}
}
/**
* Send a sticker to a Telegram chat by file_id.
* @param to - Chat ID or username (e.g., "123456789" or "@username")
* @param fileId - Telegram file_id of the sticker to send
* @param opts - Optional configuration
*/
async function sendStickerTelegram(to, fileId, opts) {
	if (!fileId?.trim()) throw new Error("Telegram sticker file_id is required");
	const { cfg, account, api } = resolveTelegramApiContext(opts);
	const target = parseTelegramTarget(to);
	const chatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: target.chatId,
		persistTarget: to,
		verbose: opts.verbose,
		gatewayClientScopes: opts.gatewayClientScopes
	});
	const threadParams = buildTelegramThreadReplyParams({
		thread: resolveTelegramSendThreadSpec({
			targetMessageThreadId: target.messageThreadId,
			messageThreadId: opts.messageThreadId,
			chatType: target.chatType
		}),
		replyToMessageId: opts.replyToMessageId
	});
	const hasThreadParams = Object.keys(threadParams).length > 0;
	const requestWithChatNotFound = createRequestWithChatNotFound({
		requestWithDiag: createTelegramNonIdempotentRequestWithDiag({
			cfg,
			account,
			retry: opts.retry,
			verbose: opts.verbose,
			useApiErrorLogging: false
		}),
		chatId,
		input: to
	});
	const stickerParams = hasThreadParams ? threadParams : void 0;
	const result = await requestWithChatNotFound(() => api.sendSticker(chatId, fileId.trim(), stickerParams), "sticker");
	const messageId = resolveTelegramMessageIdOrThrow(result, "sticker send");
	const resolvedChatId = String(result?.chat?.id ?? chatId);
	recordSentMessage(chatId, messageId, opts.cfg);
	recordChannelActivity({
		channel: "telegram",
		accountId: account.accountId,
		direction: "outbound"
	});
	return {
		messageId: String(messageId),
		chatId: resolvedChatId
	};
}
/**
* Send a poll to a Telegram chat.
* @param to - Chat ID or username (e.g., "123456789" or "@username")
* @param poll - Poll input with question, options, maxSelections, and optional durationHours
* @param opts - Optional configuration
*/
async function sendPollTelegram(to, poll, opts) {
	const { cfg, account, api } = resolveTelegramApiContext(opts);
	const target = parseTelegramTarget(to);
	const chatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: target.chatId,
		persistTarget: to,
		verbose: opts.verbose,
		gatewayClientScopes: opts.gatewayClientScopes
	});
	const normalizedPoll = normalizePollInput(poll, { maxOptions: 10 });
	const threadParams = buildTelegramThreadReplyParams({
		thread: resolveTelegramSendThreadSpec({
			targetMessageThreadId: target.messageThreadId,
			messageThreadId: opts.messageThreadId,
			chatType: target.chatType
		}),
		replyToMessageId: opts.replyToMessageId
	});
	const pollOptions = normalizedPoll.options;
	const requestWithChatNotFound = createRequestWithChatNotFound({
		requestWithDiag: createTelegramNonIdempotentRequestWithDiag({
			cfg,
			account,
			retry: opts.retry,
			verbose: opts.verbose
		}),
		chatId,
		input: to
	});
	const durationSeconds = normalizedPoll.durationSeconds;
	if (durationSeconds === void 0 && normalizedPoll.durationHours !== void 0) throw new Error("Telegram poll durationHours is not supported. Use durationSeconds (5-600) instead.");
	if (durationSeconds !== void 0 && (durationSeconds < 5 || durationSeconds > 600)) throw new Error("Telegram poll durationSeconds must be between 5 and 600");
	const pollParams = {
		allows_multiple_answers: normalizedPoll.maxSelections > 1,
		is_anonymous: opts.isAnonymous ?? true,
		...durationSeconds !== void 0 ? { open_period: durationSeconds } : {},
		...Object.keys(threadParams).length > 0 ? threadParams : {},
		...opts.silent === true ? { disable_notification: true } : {}
	};
	const result = await requestWithChatNotFound(() => api.sendPoll(chatId, normalizedPoll.question, pollOptions, pollParams), "poll");
	const messageId = resolveTelegramMessageIdOrThrow(result, "poll send");
	const resolvedChatId = String(result?.chat?.id ?? chatId);
	const pollId = result?.poll?.id;
	recordSentMessage(chatId, messageId, opts.cfg);
	recordChannelActivity({
		channel: "telegram",
		accountId: account.accountId,
		direction: "outbound"
	});
	return {
		messageId: String(messageId),
		chatId: resolvedChatId,
		pollId
	};
}
/**
* Create a forum topic in a Telegram supergroup.
* Requires the bot to have `can_manage_topics` permission.
*
* @param chatId - Supergroup chat ID
* @param name - Topic name (1-128 characters)
* @param opts - Optional configuration
*/
async function createForumTopicTelegram(chatId, name, opts) {
	if (!name?.trim()) throw new Error("Forum topic name is required");
	const trimmedName = name.trim();
	if (trimmedName.length > 128) throw new Error("Forum topic name must be 128 characters or fewer");
	const { cfg, account, api } = resolveTelegramApiContext(opts);
	const normalizedChatId = await resolveAndPersistChatId({
		cfg,
		api,
		lookupTarget: parseTelegramTarget(chatId).chatId,
		persistTarget: chatId,
		verbose: opts.verbose,
		gatewayClientScopes: opts.gatewayClientScopes
	});
	const requestWithDiag = createTelegramNonIdempotentRequestWithDiag({
		cfg,
		account,
		retry: opts.retry,
		verbose: opts.verbose
	});
	const extra = {};
	if (opts.iconColor != null) extra.icon_color = opts.iconColor;
	if (opts.iconCustomEmojiId?.trim()) extra.icon_custom_emoji_id = opts.iconCustomEmojiId.trim();
	const hasExtra = Object.keys(extra).length > 0;
	const result = await requestWithDiag(() => api.createForumTopic(normalizedChatId, trimmedName, hasExtra ? extra : void 0), "createForumTopic");
	const topicId = result.message_thread_id;
	recordChannelActivity({
		channel: "telegram",
		accountId: account.accountId,
		direction: "outbound"
	});
	return {
		topicId,
		name: result.name ?? trimmedName,
		chatId: normalizedChatId
	};
}
//#endregion
export { Bot$1 as A, createTelegramClientFetch as C, splitTelegramCaption as D, resolveTelegramOutboundClientTimeoutFloorSeconds as E, sequentialize as M, withTelegramApiErrorLogging as O, asTelegramClientFetch as S, resolveTelegramClientTimeoutSeconds as T, wasSentByBot as _, editMessageTelegram as a, removeTelegramNativeQuoteParam as b, renameForumTopicTelegram as c, sendPollTelegram as d, sendStickerTelegram as f, recordSentMessage as g, resolveTelegramVoiceSend as h, editMessageReplyMarkupTelegram as i, apiThrottler as j, getOrCreateAccountThrottler as k, resetTelegramClientOptionsCacheForTests as l, unpinMessageTelegram as m, deleteMessageTelegram as n, pinMessageTelegram as o, sendTypingTelegram as p, editForumTopicTelegram as r, reactMessageTelegram as s, createForumTopicTelegram as t, sendMessageTelegram as u, buildTelegramSendParams as v, resolveTelegramClientTimeoutMinimumSeconds as w, buildInlineKeyboard as x, getTelegramNativeQuoteReplyMessageId as y };
