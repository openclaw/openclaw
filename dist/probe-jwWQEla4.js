import { f as readStringValue } from "./string-coerce-LndEvhRk.js";
import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { d as registerUnhandledRejectionHandler, u as registerUncaughtExceptionHandler } from "./unhandled-rejections-BtmpQ7E_.js";
import { i as getRuntimeConfig } from "./io-5xE1dPMK.js";
import { t as resolveAgentMaxConcurrent } from "./agent-limits-qtYgUquT.js";
import { u as normalizeMessageChannel } from "./message-channel-s-A-ruKR.js";
import { D as resolveExecApprovalRequestAllowedDecisions } from "./exec-approvals-F42asPlK.js";
import { r as fetchWithTimeout } from "./fetch-timeout-BxQNNg4F.js";
import { r as makeProxyFetch } from "./proxy-fetch-Bt2vOwKb.js";
import { t as resolveTelegramAllowedUpdates } from "./allowed-updates-DHbbTS0P.js";
import { n as resolveTelegramFetch, r as resolveTelegramTransport, t as resolveTelegramApiBase } from "./fetch-CX6QcbV_.js";
import "./error-runtime-BnVeBNYa.js";
import { t as waitForAbortSignal } from "./abort-signal-C_Z4B-B8.js";
import "./runtime-env-AKjXcC53.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import { i as isTelegramPollingNetworkError, t as isRecoverableTelegramNetworkError } from "./network-errors-eWehYGa6.js";
import "./routing-BfSZVtOk.js";
import { o as buildExecApprovalPendingReplyPayload } from "./exec-approval-reply-EV2HWtya.js";
import { t as CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "./approval-handler-adapter-runtime-DG5nC6uH.js";
import { t as resolveExecApprovalCommandDisplay } from "./exec-approval-command-display-CSKAGCdY.js";
import { r as registerChannelRuntimeContext } from "./channel-runtime-context-BRtcYaLp.js";
import "./approval-reply-runtime-BT3hlhXm.js";
import "./runtime-config-snapshot-pRc6W_Li.js";
import "./model-session-runtime-CDfL2HP7.js";
import "./ssrf-runtime-B7YsbRmp.js";
import { a as listTokenSourcedAccounts, i as createUnionActionGate, r as resolveReactionMessageId } from "./channel-actions-BDOLVWJN.js";
import "./text-utility-runtime-CG5gZFsT.js";
import { t as extractToolSend } from "./tool-send-BuLLZYYU.js";
import { c as resolveTelegramPollActionGateState, n as listEnabledTelegramAccounts, o as resolveTelegramAccount, t as createTelegramActionGate } from "./accounts-DQtKXSlz.js";
import { t as isTelegramInlineButtonsEnabled } from "./inline-buttons-CQ4dSj3W.js";
import { a as isTelegramExecApprovalHandlerConfigured, i as isTelegramExecApprovalClientEnabled } from "./exec-approvals-k77vrJz-.js";
import { createHash } from "node:crypto";
import { Type } from "typebox";
//#region extensions/telegram/src/message-tool-schema.ts
function createTelegramPollExtraToolSchemas() {
	return {
		pollDurationSeconds: Type.Optional(Type.Number()),
		pollAnonymous: Type.Optional(Type.Boolean()),
		pollPublic: Type.Optional(Type.Boolean())
	};
}
//#endregion
//#region extensions/telegram/src/channel-actions.ts
let telegramActionRuntimePromise = null;
async function loadTelegramActionRuntime() {
	telegramActionRuntimePromise ??= import("./action-runtime-DbJf9cox.js");
	return await telegramActionRuntimePromise;
}
const telegramMessageActionRuntime = { handleTelegramAction: async (...args) => {
	const { handleTelegramAction } = await loadTelegramActionRuntime();
	return await handleTelegramAction(...args);
} };
const TELEGRAM_MESSAGE_ACTION_MAP = {
	delete: "deleteMessage",
	edit: "editMessage",
	poll: "poll",
	react: "react",
	send: "sendMessage",
	sticker: "sendSticker",
	"sticker-search": "searchSticker",
	"topic-create": "createForumTopic",
	"topic-edit": "editForumTopic"
};
function resolveTelegramMessageActionName(action) {
	return TELEGRAM_MESSAGE_ACTION_MAP[action];
}
function resolveTelegramActionDiscovery(cfg) {
	const accounts = listTokenSourcedAccounts(listEnabledTelegramAccounts(cfg));
	if (accounts.length === 0) return null;
	const unionGate = createUnionActionGate(accounts, (account) => createTelegramActionGate({
		cfg,
		accountId: account.accountId
	}));
	return {
		isEnabled: (key, defaultValue = true) => unionGate(key, defaultValue),
		pollEnabled: accounts.some((account) => {
			return resolveTelegramPollActionGateState(createTelegramActionGate({
				cfg,
				accountId: account.accountId
			})).enabled;
		}),
		buttonsEnabled: accounts.some((account) => isTelegramInlineButtonsEnabled({
			cfg,
			accountId: account.accountId
		}))
	};
}
function resolveScopedTelegramActionDiscovery(params) {
	if (!params.accountId) return resolveTelegramActionDiscovery(params.cfg);
	const account = resolveTelegramAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account.enabled || account.tokenSource === "none") return null;
	const gate = createTelegramActionGate({
		cfg: params.cfg,
		accountId: account.accountId
	});
	return {
		isEnabled: (key, defaultValue = true) => gate(key, defaultValue),
		pollEnabled: resolveTelegramPollActionGateState(gate).enabled,
		buttonsEnabled: isTelegramInlineButtonsEnabled({
			cfg: params.cfg,
			accountId: account.accountId
		})
	};
}
function describeTelegramMessageTool({ cfg, accountId }) {
	const discovery = resolveScopedTelegramActionDiscovery({
		cfg,
		accountId
	});
	if (!discovery) return {
		actions: [],
		capabilities: [],
		schema: null
	};
	const actions = new Set(["send"]);
	if (discovery.pollEnabled) actions.add("poll");
	if (discovery.isEnabled("reactions")) actions.add("react");
	if (discovery.isEnabled("deleteMessage")) actions.add("delete");
	if (discovery.isEnabled("editMessage")) actions.add("edit");
	if (discovery.isEnabled("sticker", false)) {
		actions.add("sticker");
		actions.add("sticker-search");
	}
	if (discovery.isEnabled("createForumTopic")) actions.add("topic-create");
	if (discovery.isEnabled("editForumTopic")) actions.add("topic-edit");
	const schema = [];
	if (discovery.pollEnabled) schema.push({
		properties: createTelegramPollExtraToolSchemas(),
		visibility: "all-configured"
	});
	return {
		actions: Array.from(actions),
		capabilities: discovery.buttonsEnabled ? ["presentation", "delivery-pin"] : ["delivery-pin"],
		schema
	};
}
const telegramMessageActions = {
	describeMessageTool: describeTelegramMessageTool,
	resolveExecutionMode: () => "gateway",
	resolveCliActionRequest: ({ action, args }) => {
		if (action !== "thread-create") return {
			action,
			args
		};
		const { threadName, ...rest } = args;
		return {
			action: "topic-create",
			args: {
				...rest,
				name: readStringValue(threadName)
			}
		};
	},
	extractToolSend: ({ args }) => {
		return extractToolSend(args, "sendMessage");
	},
	handleAction: async ({ action, params, cfg, accountId, mediaLocalRoots, sessionKey, toolContext }) => {
		const telegramAction = resolveTelegramMessageActionName(action);
		if (!telegramAction) throw new Error(`Unsupported Telegram action: ${action}`);
		return await telegramMessageActionRuntime.handleTelegramAction({
			...params,
			action: telegramAction,
			accountId: accountId ?? void 0,
			...action === "react" ? { messageId: resolveReactionMessageId({
				args: params,
				toolContext
			}) } : {}
		}, cfg, {
			mediaLocalRoots,
			sessionKey
		});
	}
};
//#endregion
//#region extensions/telegram/src/exec-approval-forwarding.ts
function shouldSuppressTelegramExecApprovalForwardingFallback(params) {
	if ((normalizeMessageChannel(params.target.channel) ?? params.target.channel) !== "telegram") return false;
	if (normalizeMessageChannel(params.request.request.turnSourceChannel ?? "") !== "telegram") return false;
	const accountId = params.target.accountId?.trim() || params.request.request.turnSourceAccountId?.trim();
	return isTelegramExecApprovalClientEnabled({
		cfg: params.cfg,
		accountId
	});
}
function buildTelegramExecApprovalPendingPayload(params) {
	return buildExecApprovalPendingReplyPayload({
		approvalId: params.request.id,
		approvalSlug: params.request.id.slice(0, 8),
		approvalCommandId: params.request.id,
		warningText: params.request.request.warningText ?? void 0,
		command: resolveExecApprovalCommandDisplay(params.request.request).commandText,
		cwd: params.request.request.cwd ?? void 0,
		host: params.request.request.host === "node" ? "node" : "gateway",
		nodeId: params.request.request.nodeId ?? void 0,
		allowedDecisions: resolveExecApprovalRequestAllowedDecisions(params.request.request),
		expiresAtMs: params.request.expiresAtMs,
		nowMs: params.nowMs
	});
}
//#endregion
//#region extensions/telegram/src/polling-lease.ts
const TELEGRAM_POLLING_LEASES_KEY = Symbol.for("openclaw.telegram.pollingLeases");
const DEFAULT_TELEGRAM_POLLING_LEASE_WAIT_MS = 5e3;
function pollingLeaseRegistry() {
	const proc = process;
	proc[TELEGRAM_POLLING_LEASES_KEY] ??= /* @__PURE__ */ new Map();
	return proc[TELEGRAM_POLLING_LEASES_KEY];
}
function tokenFingerprint(token) {
	return createHash("sha256").update(token).digest("hex").slice(0, 16);
}
function createDuplicatePollingError(params) {
	const ageMs = Math.max(0, Date.now() - params.existing.startedAt);
	const ageSeconds = Math.round(ageMs / 1e3);
	return /* @__PURE__ */ new Error(`Telegram polling already active for bot token ${params.tokenFingerprint} on account "${params.existing.accountId}" (${ageSeconds}s old); refusing duplicate poller for account "${params.accountId}". Stop the existing OpenClaw gateway/poller or use a different bot token.`);
}
async function waitForPreviousRelease(params) {
	if (params.signal?.aborted) return "aborted";
	let timer;
	let abortListener;
	try {
		const timeout = new Promise((resolve) => {
			timer = setTimeout(() => resolve("timeout"), Math.max(0, params.waitMs));
			timer.unref?.();
		});
		const aborted = new Promise((resolve) => {
			abortListener = () => resolve("aborted");
			params.signal?.addEventListener("abort", abortListener, { once: true });
		});
		const released = params.done.then(() => "released");
		return await Promise.race([
			released,
			timeout,
			aborted
		]);
	} finally {
		if (timer) clearTimeout(timer);
		if (abortListener) params.signal?.removeEventListener("abort", abortListener);
	}
}
function createLease(params) {
	let resolveDone;
	const done = new Promise((resolve) => {
		resolveDone = resolve;
	});
	const owner = Symbol(`telegram-polling:${params.accountId}`);
	const entry = {
		accountId: params.accountId,
		abortSignal: params.abortSignal,
		done,
		owner,
		resolveDone,
		startedAt: Date.now()
	};
	params.registry.set(params.tokenFingerprint, entry);
	let released = false;
	return {
		tokenFingerprint: params.tokenFingerprint,
		waitedForPrevious: params.waitedForPrevious,
		replacedStoppingPrevious: params.replacedStoppingPrevious,
		release: () => {
			if (released) return;
			released = true;
			if (params.registry.get(params.tokenFingerprint)?.owner === owner) params.registry.delete(params.tokenFingerprint);
			resolveDone();
		}
	};
}
async function acquireTelegramPollingLease(opts) {
	const registry = pollingLeaseRegistry();
	const fingerprint = tokenFingerprint(opts.token);
	const waitMs = opts.waitMs ?? DEFAULT_TELEGRAM_POLLING_LEASE_WAIT_MS;
	let waitedForPrevious = false;
	for (;;) {
		const existing = registry.get(fingerprint);
		if (!existing) return createLease({
			accountId: opts.accountId,
			abortSignal: opts.abortSignal,
			registry,
			tokenFingerprint: fingerprint,
			waitedForPrevious,
			replacedStoppingPrevious: false
		});
		if (!existing.abortSignal?.aborted) throw createDuplicatePollingError({
			accountId: opts.accountId,
			existing,
			tokenFingerprint: fingerprint
		});
		waitedForPrevious = true;
		const waitResult = await waitForPreviousRelease({
			done: existing.done,
			signal: opts.abortSignal,
			waitMs
		});
		if (waitResult === "aborted") throw new Error(`Telegram polling start aborted while waiting for previous poller for bot token ${fingerprint} to stop.`);
		if (registry.get(fingerprint) !== existing) continue;
		if (waitResult === "released") continue;
		return createLease({
			accountId: opts.accountId,
			abortSignal: opts.abortSignal,
			registry,
			tokenFingerprint: fingerprint,
			waitedForPrevious,
			replacedStoppingPrevious: true
		});
	}
}
//#endregion
//#region extensions/telegram/src/monitor.ts
function createTelegramRunnerOptions(cfg) {
	return {
		sink: { concurrency: resolveAgentMaxConcurrent(cfg) },
		runner: {
			fetch: {
				timeout: 30,
				allowed_updates: resolveTelegramAllowedUpdates()
			},
			silent: true,
			maxRetryTime: 3600 * 1e3,
			retryInterval: "exponential"
		}
	};
}
function normalizePersistedUpdateId(value) {
	if (value === null) return null;
	if (!Number.isSafeInteger(value) || value < 0) return null;
	return value;
}
/** Check if error is a Grammy HttpError (used to scope unhandled rejection handling) */
const isGrammyHttpError = (err) => {
	if (!err || typeof err !== "object") return false;
	return err.name === "HttpError";
};
let telegramMonitorPollingRuntimePromise;
async function loadTelegramMonitorPollingRuntime() {
	telegramMonitorPollingRuntimePromise ??= import("./monitor-polling.runtime.js");
	return await telegramMonitorPollingRuntimePromise;
}
let telegramMonitorWebhookRuntimePromise;
async function loadTelegramMonitorWebhookRuntime() {
	telegramMonitorWebhookRuntimePromise ??= import("./monitor-webhook.runtime.js");
	return await telegramMonitorWebhookRuntimePromise;
}
async function monitorTelegramProvider(opts = {}) {
	const log = opts.runtime?.error ?? console.error;
	let pollingSession;
	const handlePollingNetworkFailure = (err, label) => {
		const isNetworkError = isRecoverableTelegramNetworkError(err, { context: "polling" });
		const isTelegramPollingError = isTelegramPollingNetworkError(err);
		const activeRunner = pollingSession?.activeRunner;
		if (isNetworkError && isTelegramPollingError && activeRunner && activeRunner.isRunning()) {
			pollingSession?.markForceRestarted();
			pollingSession?.markTransportDirty();
			pollingSession?.abortActiveFetch();
			activeRunner.stop().catch(() => {});
			log("[telegram][diag] marking transport dirty after polling network failure");
			log(`[telegram] Restarting polling after ${label}: ${formatErrorMessage(err)}`);
			return true;
		}
		if (isGrammyHttpError(err) && isNetworkError && isTelegramPollingError) {
			log(`[telegram] Suppressed network error: ${formatErrorMessage(err)}`);
			return true;
		}
		return false;
	};
	const unregisterUnhandledRejectionHandler = registerUnhandledRejectionHandler((err) => handlePollingNetworkFailure(err, "unhandled network error"));
	const unregisterUncaughtExceptionHandler = registerUncaughtExceptionHandler((err) => handlePollingNetworkFailure(err, "uncaught network error"));
	try {
		const cfg = opts.config ?? getRuntimeConfig();
		const account = resolveTelegramAccount({
			cfg,
			accountId: opts.accountId
		});
		const token = opts.token?.trim() || account.token;
		if (!token) throw new Error(`Telegram bot token missing for account "${account.accountId}" (set channels.telegram.accounts.${account.accountId}.botToken/tokenFile or TELEGRAM_BOT_TOKEN for default).`);
		const proxyFetch = opts.proxyFetch ?? (account.config.proxy ? makeProxyFetch(account.config.proxy) : void 0);
		if (opts.useWebhook) {
			const { startTelegramWebhook } = await loadTelegramMonitorWebhookRuntime();
			if (isTelegramExecApprovalHandlerConfigured({
				cfg,
				accountId: account.accountId
			})) registerChannelRuntimeContext({
				channelRuntime: opts.channelRuntime,
				channelId: "telegram",
				accountId: account.accountId,
				capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
				context: { token },
				abortSignal: opts.abortSignal
			});
			await startTelegramWebhook({
				token,
				accountId: account.accountId,
				config: cfg,
				path: opts.webhookPath,
				port: opts.webhookPort,
				secret: opts.webhookSecret ?? account.config.webhookSecret,
				host: opts.webhookHost ?? account.config.webhookHost,
				runtime: opts.runtime,
				fetch: proxyFetch,
				abortSignal: opts.abortSignal,
				publicUrl: opts.webhookUrl,
				webhookCertPath: opts.webhookCertPath,
				setStatus: opts.setStatus
			});
			await waitForAbortSignal(opts.abortSignal);
			return;
		}
		const { TelegramPollingSession, readTelegramUpdateOffset, writeTelegramUpdateOffset } = await loadTelegramMonitorPollingRuntime();
		const pollingLease = await acquireTelegramPollingLease({
			token,
			accountId: account.accountId,
			abortSignal: opts.abortSignal
		});
		if (pollingLease.waitedForPrevious) log(`[telegram][diag] waited for previous polling session for bot token ${pollingLease.tokenFingerprint} before starting account "${account.accountId}".`);
		if (pollingLease.replacedStoppingPrevious) log(`[telegram][diag] previous polling session for bot token ${pollingLease.tokenFingerprint} did not stop within the lease wait; starting a replacement for account "${account.accountId}".`);
		try {
			if (isTelegramExecApprovalHandlerConfigured({
				cfg,
				accountId: account.accountId
			})) registerChannelRuntimeContext({
				channelRuntime: opts.channelRuntime,
				channelId: "telegram",
				accountId: account.accountId,
				capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
				context: { token },
				abortSignal: opts.abortSignal
			});
			const persistedOffsetRaw = await readTelegramUpdateOffset({
				accountId: account.accountId,
				botToken: token
			});
			let lastUpdateId = normalizePersistedUpdateId(persistedOffsetRaw);
			if (persistedOffsetRaw !== null && lastUpdateId === null) log(`[telegram] Ignoring invalid persisted update offset (${String(persistedOffsetRaw)}); starting without offset confirmation.`);
			const persistUpdateId = async (updateId) => {
				const normalizedUpdateId = normalizePersistedUpdateId(updateId);
				if (normalizedUpdateId === null) {
					log(`[telegram] Ignoring invalid update_id value: ${String(updateId)}`);
					return;
				}
				if (lastUpdateId !== null && normalizedUpdateId <= lastUpdateId) return;
				lastUpdateId = normalizedUpdateId;
				try {
					await writeTelegramUpdateOffset({
						accountId: account.accountId,
						updateId: normalizedUpdateId,
						botToken: token
					});
				} catch (err) {
					(opts.runtime?.error ?? console.error)(`telegram: failed to persist update offset: ${String(err)}`);
				}
			};
			const createTelegramTransportForPolling = () => resolveTelegramTransport(proxyFetch, { network: account.config.network });
			const telegramTransport = createTelegramTransportForPolling();
			pollingSession = new TelegramPollingSession({
				token,
				config: cfg,
				accountId: account.accountId,
				runtime: opts.runtime,
				proxyFetch,
				botInfo: opts.botInfo,
				abortSignal: opts.abortSignal,
				runnerOptions: createTelegramRunnerOptions(cfg),
				getLastUpdateId: () => lastUpdateId,
				persistUpdateId,
				log,
				telegramTransport,
				createTelegramTransport: createTelegramTransportForPolling,
				stallThresholdMs: account.config.pollingStallThresholdMs,
				setStatus: opts.setStatus,
				isolatedIngress: {
					enabled: opts.isolatedIngress?.enabled ?? true,
					apiRoot: account.config.apiRoot,
					timeoutSeconds: account.config.timeoutSeconds,
					proxy: account.config.proxy,
					network: account.config.network
				}
			});
			await pollingSession.runUntilAbort();
		} finally {
			pollingLease.release();
		}
	} finally {
		unregisterUnhandledRejectionHandler();
		unregisterUncaughtExceptionHandler();
	}
}
//#endregion
//#region extensions/telegram/src/probe.ts
const probeFetcherCache = /* @__PURE__ */ new Map();
const MAX_PROBE_FETCHER_CACHE_SIZE = 64;
function resetTelegramProbeFetcherCacheForTests() {
	probeFetcherCache.clear();
}
function resolveProbeOptions(proxyOrOptions) {
	if (!proxyOrOptions) return;
	if (typeof proxyOrOptions === "string") return { proxyUrl: proxyOrOptions };
	return proxyOrOptions;
}
function shouldUseProbeFetcherCache() {
	return !process.env.VITEST && true;
}
function buildProbeFetcherCacheKey(token, options) {
	const cacheIdentity = options?.accountId?.trim() || token;
	const cacheIdentityKind = options?.accountId?.trim() ? "account" : "token";
	const proxyKey = options?.proxyUrl?.trim() ?? "";
	const autoSelectFamily = options?.network?.autoSelectFamily;
	return `${cacheIdentityKind}:${cacheIdentity}::${proxyKey}::${typeof autoSelectFamily === "boolean" ? String(autoSelectFamily) : "default"}::${options?.network?.dnsResultOrder ?? "default"}::${options?.apiRoot?.trim() ?? ""}`;
}
function setCachedProbeFetcher(cacheKey, fetcher) {
	probeFetcherCache.set(cacheKey, fetcher);
	if (probeFetcherCache.size > MAX_PROBE_FETCHER_CACHE_SIZE) {
		const oldestKey = probeFetcherCache.keys().next().value;
		if (oldestKey !== void 0) probeFetcherCache.delete(oldestKey);
	}
	return fetcher;
}
function resolveProbeFetcher(token, options) {
	const cacheKey = shouldUseProbeFetcherCache() ? buildProbeFetcherCacheKey(token, options) : null;
	if (cacheKey) {
		const cachedFetcher = probeFetcherCache.get(cacheKey);
		if (cachedFetcher) return cachedFetcher;
	}
	const proxyUrl = options?.proxyUrl?.trim();
	const resolved = resolveTelegramFetch(proxyUrl ? makeProxyFetch(proxyUrl) : void 0, { network: options?.network });
	if (cacheKey) return setCachedProbeFetcher(cacheKey, resolved);
	return resolved;
}
function normalizeBoolean(value) {
	return typeof value === "boolean" ? value : null;
}
function normalizeTelegramBotInfo(value) {
	if (!value || typeof value !== "object") return;
	const bot = value;
	if (typeof bot.id !== "number" || bot.is_bot !== true || typeof bot.first_name !== "string" || typeof bot.username !== "string") return;
	return {
		id: bot.id,
		is_bot: true,
		first_name: bot.first_name,
		username: bot.username,
		...typeof bot.last_name === "string" ? { last_name: bot.last_name } : {},
		...typeof bot.language_code === "string" ? { language_code: bot.language_code } : {},
		can_join_groups: normalizeBoolean(bot.can_join_groups) ?? false,
		can_read_all_group_messages: normalizeBoolean(bot.can_read_all_group_messages) ?? false,
		can_manage_bots: normalizeBoolean(bot.can_manage_bots) ?? false,
		supports_inline_queries: normalizeBoolean(bot.supports_inline_queries) ?? false,
		can_connect_to_business: normalizeBoolean(bot.can_connect_to_business) ?? false,
		has_main_web_app: normalizeBoolean(bot.has_main_web_app) ?? false,
		has_topics_enabled: normalizeBoolean(bot.has_topics_enabled) ?? false,
		allows_users_to_create_topics: normalizeBoolean(bot.allows_users_to_create_topics) ?? false
	};
}
async function probeTelegram(token, timeoutMs, proxyOrOptions) {
	const started = Date.now();
	const timeoutBudgetMs = Math.max(1, Math.floor(timeoutMs));
	const deadlineMs = started + timeoutBudgetMs;
	const options = resolveProbeOptions(proxyOrOptions);
	const includeWebhookInfo = options?.includeWebhookInfo !== false;
	const fetcher = resolveProbeFetcher(token, options);
	const base = `${resolveTelegramApiBase(options?.apiRoot)}/bot${token}`;
	const retryDelayMs = Math.max(50, Math.min(1e3, Math.floor(timeoutBudgetMs / 5)));
	const resolveRemainingBudgetMs = () => Math.max(0, deadlineMs - Date.now());
	const result = {
		ok: false,
		status: null,
		error: null,
		elapsedMs: 0
	};
	try {
		let meRes = null;
		let fetchError = null;
		for (let i = 0; i < 3; i++) {
			const remainingBudgetMs = resolveRemainingBudgetMs();
			if (remainingBudgetMs <= 0) break;
			try {
				meRes = await fetchWithTimeout(`${base}/getMe`, {}, Math.max(1, Math.min(timeoutBudgetMs, remainingBudgetMs)), fetcher);
				break;
			} catch (err) {
				fetchError = err;
				if (i < 2) {
					const remainingAfterAttemptMs = resolveRemainingBudgetMs();
					if (remainingAfterAttemptMs <= 0) break;
					const delayMs = Math.min(retryDelayMs, remainingAfterAttemptMs);
					if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
				}
			}
		}
		if (!meRes) throw fetchError ?? /* @__PURE__ */ new Error(`probe timed out after ${timeoutBudgetMs}ms`);
		const meJson = await meRes.json();
		if (!meRes.ok || !meJson?.ok) {
			result.status = meRes.status;
			result.error = meJson?.description ?? `getMe failed (${meRes.status})`;
			return {
				...result,
				elapsedMs: Date.now() - started
			};
		}
		const botInfo = normalizeTelegramBotInfo(meJson.result);
		const bot = meJson.result && typeof meJson.result === "object" ? meJson.result : {};
		if (botInfo) result.botInfo = botInfo;
		result.bot = {
			id: typeof bot.id === "number" ? bot.id : null,
			isBot: normalizeBoolean(bot.is_bot),
			firstName: typeof bot.first_name === "string" ? bot.first_name : null,
			username: typeof bot.username === "string" ? bot.username : null,
			canJoinGroups: normalizeBoolean(bot.can_join_groups),
			canReadAllGroupMessages: normalizeBoolean(bot.can_read_all_group_messages),
			canManageBots: normalizeBoolean(bot.can_manage_bots),
			supportsInlineQueries: normalizeBoolean(bot.supports_inline_queries),
			canConnectToBusiness: normalizeBoolean(bot.can_connect_to_business),
			hasMainWebApp: normalizeBoolean(bot.has_main_web_app),
			hasTopicsEnabled: normalizeBoolean(bot.has_topics_enabled),
			allowsUsersToCreateTopics: normalizeBoolean(bot.allows_users_to_create_topics)
		};
		if (includeWebhookInfo) try {
			const webhookRemainingBudgetMs = resolveRemainingBudgetMs();
			if (webhookRemainingBudgetMs > 0) {
				const webhookRes = await fetchWithTimeout(`${base}/getWebhookInfo`, {}, Math.max(1, Math.min(timeoutBudgetMs, webhookRemainingBudgetMs)), fetcher);
				const webhookJson = await webhookRes.json();
				if (webhookRes.ok && webhookJson?.ok) result.webhook = {
					url: webhookJson.result?.url ?? null,
					hasCustomCert: webhookJson.result?.has_custom_certificate ?? null
				};
			}
		} catch {}
		result.ok = true;
		result.status = null;
		result.error = null;
		result.elapsedMs = Date.now() - started;
		return result;
	} catch (err) {
		return {
			...result,
			status: err instanceof Response ? err.status : result.status,
			error: formatErrorMessage(err),
			elapsedMs: Date.now() - started
		};
	}
}
//#endregion
export { shouldSuppressTelegramExecApprovalForwardingFallback as a, buildTelegramExecApprovalPendingPayload as i, resetTelegramProbeFetcherCacheForTests as n, telegramMessageActions as o, monitorTelegramProvider as r, probeTelegram as t };
