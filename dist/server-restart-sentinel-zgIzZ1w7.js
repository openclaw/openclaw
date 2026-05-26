import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { _ as resolveSessionAgentId } from "./agent-scope-CtLXGcWm.js";
import { C as moveJsonDurableQueueEntryToFailed, E as writeJsonDurableQueueEntry, S as loadPendingJsonDurableQueueEntries, T as resolveJsonDurableQueueEntryPaths, b as jsonDurableQueueEntryExists, c as enqueueDelivery, s as ackDelivery, u as failDelivery, v as ackJsonDurableQueueEntry, w as readJsonDurableQueueEntry, x as loadJsonDurableQueueEntry, y as ensureJsonDurableQueueDirs } from "./delivery-queue-DiT8Zaph.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { r as INTERNAL_MESSAGE_CHANNEL } from "./message-channel-core-BoUoCGOD.js";
import "./message-channel-CYCKkVrh.js";
import { h as stringifyRouteThreadId } from "./channel-route-L2PJ-xNE.js";
import { i as mergeDeliveryContext, n as deliveryContextFromSession } from "./delivery-context.shared-CBmB9dF7.js";
import { D as parseSessionThreadInfo } from "./store-load-z4thf6ld.js";
import { a as normalizeChannelId, t as getChannelPlugin } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { l as resolveMainSessionKeyFromConfig } from "./sessions-CQHHcgC_.js";
import { o as requestHeartbeat } from "./heartbeat-wake-BEc0M8hq.js";
import { a as enqueueSystemEvent } from "./system-events-11EG3LzK.js";
import { c as loadSessionEntry } from "./session-utils-CRKr-5AU.js";
import { c as resolveRestartSentinelPath, i as formatRestartSentinelMessage, l as summarizeRestartSentinel, n as finalizeUpdateRestartSentinelRunningVersion, o as readRestartSentinel, s as removeRestartSentinelFile } from "./restart-sentinel-BDtpdKoy.js";
import { a as generateSecureUuid } from "./secure-random-BxnbXS5x.js";
import { t as buildOutboundSessionContext } from "./session-context-DSIPIqLK.js";
import { t as sendDurableMessageBatch } from "./send-CGvo7HYh.js";
import "./runtime-BN74dT7u.js";
import { r as resolveOutboundTarget } from "./targets-CNDTJ9IB.js";
import { t as finalizeInboundContext } from "./inbound-context-Cg0uCtqQ.js";
import { t as dispatchReplyWithBufferedBlockDispatcher } from "./provider-dispatcher-1HiDGh16.js";
import { t as recordInboundSession } from "./session-CCAfHrW1.js";
import { n as dispatchAssembledChannelTurn } from "./kernel-BXIm_f4L.js";
import "./get-reply-run-queue-rHDSW38T.js";
import { t as runStartupTasks } from "./startup-tasks-Uk0WDxvd.js";
import { n as timestampOptsFromConfig, t as injectTimestamp } from "./agent-timestamp-JdPenpRZ.js";
import { a as isPendingControlPlaneUpdateRestartSentinel } from "./update-control-plane-sentinel-C4970WGr.js";
import path from "node:path";
import { createHash } from "node:crypto";
//#region src/infra/session-delivery-queue-storage.ts
const QUEUE_DIRNAME = "session-delivery-queue";
const FAILED_DIRNAME = "failed";
const TMP_SWEEP_MAX_AGE_MS = 5e3;
const QUEUE_TEMP_PREFIX = ".session-delivery-queue";
function buildEntryId(idempotencyKey) {
	if (!idempotencyKey) return generateSecureUuid();
	return createHash("sha256").update(idempotencyKey).digest("hex");
}
async function writeQueueEntry(filePath, entry) {
	await writeJsonDurableQueueEntry({
		filePath,
		entry,
		tempPrefix: QUEUE_TEMP_PREFIX
	});
}
async function readQueueEntry(filePath) {
	return await readJsonDurableQueueEntry(filePath);
}
function resolveSessionDeliveryQueueDir(stateDir) {
	const base = stateDir ?? resolveStateDir();
	return path.join(base, QUEUE_DIRNAME);
}
function resolveFailedDir(stateDir) {
	return path.join(resolveSessionDeliveryQueueDir(stateDir), FAILED_DIRNAME);
}
function resolveQueueEntryPaths(id, stateDir) {
	return resolveJsonDurableQueueEntryPaths(resolveSessionDeliveryQueueDir(stateDir), id);
}
async function ensureSessionDeliveryQueueDir(stateDir) {
	const queueDir = resolveSessionDeliveryQueueDir(stateDir);
	await ensureJsonDurableQueueDirs({
		queueDir,
		failedDir: resolveFailedDir(stateDir)
	});
	return queueDir;
}
async function enqueueSessionDelivery(params, stateDir) {
	const queueDir = await ensureSessionDeliveryQueueDir(stateDir);
	const id = buildEntryId(params.idempotencyKey);
	const filePath = path.join(queueDir, `${id}.json`);
	if (params.idempotencyKey) {
		if (await jsonDurableQueueEntryExists(filePath)) return id;
	}
	await writeQueueEntry(filePath, {
		...params,
		id,
		enqueuedAt: Date.now(),
		retryCount: 0
	});
	return id;
}
async function ackSessionDelivery(id, stateDir) {
	await ackJsonDurableQueueEntry(resolveQueueEntryPaths(id, stateDir));
}
async function failSessionDelivery(id, error, stateDir) {
	const filePath = path.join(resolveSessionDeliveryQueueDir(stateDir), `${id}.json`);
	const entry = await readQueueEntry(filePath);
	entry.retryCount += 1;
	entry.lastAttemptAt = Date.now();
	entry.lastError = error;
	await writeQueueEntry(filePath, entry);
}
async function loadPendingSessionDelivery(id, stateDir) {
	return await loadJsonDurableQueueEntry({
		paths: resolveQueueEntryPaths(id, stateDir),
		tempPrefix: QUEUE_TEMP_PREFIX
	});
}
async function loadPendingSessionDeliveries(stateDir) {
	return await loadPendingJsonDurableQueueEntries({
		queueDir: resolveSessionDeliveryQueueDir(stateDir),
		tempPrefix: QUEUE_TEMP_PREFIX,
		cleanupTmpMaxAgeMs: TMP_SWEEP_MAX_AGE_MS
	});
}
async function moveSessionDeliveryToFailed(id, stateDir) {
	await moveJsonDurableQueueEntryToFailed({
		queueDir: resolveSessionDeliveryQueueDir(stateDir),
		failedDir: resolveFailedDir(stateDir),
		id
	});
}
//#endregion
//#region src/infra/session-delivery-queue-recovery.ts
const MAX_SESSION_DELIVERY_RETRIES = 5;
const BACKOFF_MS = [
	5e3,
	25e3,
	12e4,
	6e5
];
const drainInProgress = /* @__PURE__ */ new Map();
const entriesInProgress = /* @__PURE__ */ new Set();
function getErrnoCode(err) {
	return err && typeof err === "object" && "code" in err ? String(err.code) : null;
}
function createEmptyRecoverySummary() {
	return {
		recovered: 0,
		failed: 0,
		skippedMaxRetries: 0,
		deferredBackoff: 0
	};
}
function claimRecoveryEntry(entryId) {
	if (entriesInProgress.has(entryId)) return false;
	entriesInProgress.add(entryId);
	return true;
}
function releaseRecoveryEntry(entryId) {
	entriesInProgress.delete(entryId);
}
function computeSessionDeliveryBackoffMs(retryCount) {
	if (retryCount <= 0) return 0;
	return BACKOFF_MS[Math.min(retryCount - 1, BACKOFF_MS.length - 1)] ?? BACKOFF_MS.at(-1) ?? 0;
}
function resolveSessionDeliveryMaxRetries(entry) {
	return entry.maxRetries ?? MAX_SESSION_DELIVERY_RETRIES;
}
function isSessionDeliveryEligibleForRetry(entry, now) {
	const backoff = computeSessionDeliveryBackoffMs(entry.retryCount);
	if (backoff <= 0) return { eligible: true };
	if (entry.retryCount === 0 && entry.lastAttemptAt === void 0) return { eligible: true };
	const nextEligibleAt = (typeof entry.lastAttemptAt === "number" && entry.lastAttemptAt > 0 ? entry.lastAttemptAt : entry.enqueuedAt) + backoff;
	if (now >= nextEligibleAt) return { eligible: true };
	return {
		eligible: false,
		remainingBackoffMs: nextEligibleAt - now
	};
}
async function drainQueuedEntry(opts) {
	const { entry } = opts;
	try {
		await opts.deliver(entry);
		await ackSessionDelivery(entry.id, opts.stateDir);
		opts.onRecovered?.(entry);
		return "recovered";
	} catch (err) {
		const errMsg = formatErrorMessage(err);
		opts.onFailed?.(entry, errMsg);
		try {
			await failSessionDelivery(entry.id, errMsg, opts.stateDir);
			return "failed";
		} catch (failErr) {
			if (getErrnoCode(failErr) === "ENOENT") return "already-gone";
			return "failed";
		}
	}
}
async function drainPendingSessionDeliveries(opts) {
	if (drainInProgress.get(opts.drainKey)) {
		opts.log.info(`${opts.logLabel}: already in progress for ${opts.drainKey}, skipping`);
		return;
	}
	drainInProgress.set(opts.drainKey, true);
	try {
		const matchingEntries = (await loadPendingSessionDeliveries(opts.stateDir)).filter((entry) => opts.selectEntry(entry, Date.now()).match).toSorted((a, b) => a.enqueuedAt - b.enqueuedAt);
		for (const entry of matchingEntries) {
			if (!claimRecoveryEntry(entry.id)) {
				opts.log.info(`${opts.logLabel}: entry ${entry.id} is already being recovered`);
				continue;
			}
			try {
				const currentEntry = await loadPendingSessionDelivery(entry.id, opts.stateDir);
				if (!currentEntry) continue;
				const currentDecision = opts.selectEntry(currentEntry, Date.now());
				if (!currentDecision.match) continue;
				if (currentEntry.retryCount >= resolveSessionDeliveryMaxRetries(currentEntry)) {
					try {
						await moveSessionDeliveryToFailed(currentEntry.id, opts.stateDir);
					} catch (err) {
						if (getErrnoCode(err) !== "ENOENT") throw err;
					}
					opts.log.warn(`${opts.logLabel}: entry ${currentEntry.id} exceeded max retries and was moved to failed/`);
					continue;
				}
				if (!currentDecision.bypassBackoff) {
					const retryEligibility = isSessionDeliveryEligibleForRetry(currentEntry, Date.now());
					if (!retryEligibility.eligible) {
						opts.log.info(`${opts.logLabel}: entry ${currentEntry.id} not ready for retry yet — backoff ${retryEligibility.remainingBackoffMs}ms remaining`);
						continue;
					}
				}
				await drainQueuedEntry({
					entry: currentEntry,
					deliver: opts.deliver,
					stateDir: opts.stateDir,
					onFailed: (failedEntry, errMsg) => {
						opts.log.warn(`${opts.logLabel}: retry failed for entry ${failedEntry.id}: ${errMsg}`);
					}
				});
			} finally {
				releaseRecoveryEntry(entry.id);
			}
		}
	} finally {
		drainInProgress.delete(opts.drainKey);
	}
}
async function recoverPendingSessionDeliveries(opts) {
	const pending = (await loadPendingSessionDeliveries(opts.stateDir)).filter((entry) => opts.maxEnqueuedAt == null || entry.enqueuedAt <= opts.maxEnqueuedAt);
	if (pending.length === 0) return createEmptyRecoverySummary();
	pending.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
	const summary = createEmptyRecoverySummary();
	const deadline = Date.now() + (opts.maxRecoveryMs ?? 6e4);
	for (const entry of pending) {
		if (Date.now() >= deadline) {
			opts.log.warn("Session delivery recovery time budget exceeded — remaining entries deferred");
			break;
		}
		if (!claimRecoveryEntry(entry.id)) continue;
		try {
			const currentEntry = await loadPendingSessionDelivery(entry.id, opts.stateDir);
			if (!currentEntry) continue;
			if (opts.maxEnqueuedAt != null && currentEntry.enqueuedAt > opts.maxEnqueuedAt) continue;
			if (currentEntry.retryCount >= resolveSessionDeliveryMaxRetries(currentEntry)) {
				summary.skippedMaxRetries += 1;
				try {
					await moveSessionDeliveryToFailed(currentEntry.id, opts.stateDir);
				} catch (err) {
					if (getErrnoCode(err) !== "ENOENT") throw err;
				}
				continue;
			}
			if (!isSessionDeliveryEligibleForRetry(currentEntry, Date.now()).eligible) {
				summary.deferredBackoff += 1;
				continue;
			}
			if (await drainQueuedEntry({
				entry: currentEntry,
				deliver: opts.deliver,
				stateDir: opts.stateDir,
				onRecovered: () => {
					summary.recovered += 1;
				},
				onFailed: (_failedEntry, errMsg) => {
					summary.failed += 1;
					opts.log.warn(`Session delivery retry failed: ${errMsg}`);
				}
			}) === "recovered") opts.log.info(`Recovered session delivery ${currentEntry.id}`);
		} finally {
			releaseRecoveryEntry(entry.id);
		}
	}
	return summary;
}
//#endregion
//#region src/gateway/server-restart-sentinel.ts
const log = createSubsystemLogger("gateway/restart-sentinel");
const OUTBOUND_RETRY_DELAY_MS = 1e3;
const OUTBOUND_MAX_ATTEMPTS = 45;
const RESTART_CONTINUATION_BUSY_RETRY_DELAY_MS = process.env.VITEST ? 1 : 6e3;
const RESTART_CONTINUATION_BUSY_MAX_ATTEMPTS = 20;
const CONTROL_PLANE_UPDATE_PENDING_RETRY_DELAY_MS = process.env.VITEST ? 1 : 2e3;
const CONTROL_PLANE_UPDATE_PENDING_MAX_ATTEMPTS = 900;
const RESTART_CONTINUATION_BUSY_RETRY_ERROR = "restart continuation deferred because previous run is still shutting down";
let latestUpdateRestartSentinel = null;
function cloneRestartSentinelPayload(payload) {
	if (!payload) return null;
	return JSON.parse(JSON.stringify(payload));
}
function hasRoutableDeliveryContext(context) {
	return Boolean(context?.channel && context?.to);
}
function enqueueRestartSentinelWake(message, sessionKey, deliveryContext) {
	enqueueSystemEvent(message, {
		sessionKey,
		...deliveryContext ? { deliveryContext } : {}
	});
	requestHeartbeat({
		source: "restart-sentinel",
		intent: "immediate",
		reason: "wake",
		sessionKey
	});
}
async function waitForOutboundRetry(delayMs) {
	await new Promise((resolve) => {
		setTimeout(resolve, delayMs).unref?.();
	});
}
async function deliverRestartSentinelNotice(params) {
	const payloads = [{ text: params.message }];
	const queueId = await enqueueDelivery({
		channel: params.channel,
		to: params.to,
		accountId: params.accountId,
		replyToId: params.replyToId,
		threadId: params.threadId,
		payloads,
		bestEffort: false
	}).catch(() => null);
	for (let attempt = 1; attempt <= OUTBOUND_MAX_ATTEMPTS; attempt += 1) try {
		const send = await sendDurableMessageBatch({
			cfg: params.cfg,
			channel: params.channel,
			to: params.to,
			accountId: params.accountId,
			replyToId: params.replyToId,
			threadId: params.threadId,
			payloads,
			session: params.session,
			deps: params.deps,
			bestEffort: false,
			skipQueue: true
		});
		if (send.status === "failed" || send.status === "partial_failed") throw send.error;
		if ((send.status === "sent" ? send.results : []).length > 0) {
			if (queueId) await ackDelivery(queueId).catch(() => {});
			return;
		}
		throw new Error("outbound delivery returned no results");
	} catch (err) {
		const retrying = attempt < OUTBOUND_MAX_ATTEMPTS;
		const suffix = retrying ? `; retrying in ${OUTBOUND_RETRY_DELAY_MS}ms` : "";
		log.warn(`${params.summary}: outbound delivery failed${suffix}: ${String(err)}`, {
			channel: params.channel,
			to: params.to,
			sessionKey: params.sessionKey,
			attempt,
			maxAttempts: OUTBOUND_MAX_ATTEMPTS
		});
		if (!retrying) {
			if (queueId) await failDelivery(queueId, formatErrorMessage(err)).catch(() => void 0);
			return;
		}
		await waitForOutboundRetry(OUTBOUND_RETRY_DELAY_MS);
	}
}
function buildRestartContinuationMessageId(params) {
	return `restart-sentinel:${params.sessionKey}:${params.kind}:${params.ts}`;
}
function resolveRestartContinuationRoute(params) {
	if (!params.channel || !params.to) return;
	return {
		channel: params.channel,
		to: params.to,
		...params.accountId ? { accountId: params.accountId } : {},
		...params.replyToId ? { replyToId: params.replyToId } : {},
		...params.threadId ? { threadId: params.threadId } : {},
		chatType: params.chatType
	};
}
function resolveRestartContinuationOutboundPayload(params) {
	if (params.payload.replyToId !== params.messageId) return params.payload;
	const payload = { ...params.payload };
	delete payload.replyToId;
	return params.replyToId ? {
		...payload,
		replyToId: params.replyToId
	} : payload;
}
function isRestartContinuationBusyPayload(payload) {
	return typeof payload.text === "string" && payload.text.trim() === "⚠️ Previous run is still shutting down. Please try again in a moment.";
}
function isRestartContinuationBusyRetry(entry) {
	return entry?.lastError === RESTART_CONTINUATION_BUSY_RETRY_ERROR;
}
function resolveQueuedRestartContinuationMessageId(entry) {
	if (isRestartContinuationBusyRetry(entry) && entry.retryCount > 0) return `${entry.messageId}:retry:${entry.retryCount}`;
	return entry.messageId;
}
function resolveQueuedSessionDeliveryContext(entry) {
	if (entry.kind === "agentTurn" && entry.route) return {
		channel: entry.route.channel,
		to: entry.route.to,
		...entry.route.accountId ? { accountId: entry.route.accountId } : {},
		...entry.route.threadId ? { threadId: entry.route.threadId } : {}
	};
	return entry.deliveryContext;
}
async function deliverQueuedSessionDelivery(params) {
	const { cfg, storePath, canonicalKey } = loadSessionEntry(params.entry.sessionKey);
	const queuedDeliveryContext = resolveQueuedSessionDeliveryContext(params.entry);
	if (params.entry.kind === "systemEvent") {
		enqueueSystemEvent(params.entry.text, {
			sessionKey: canonicalKey,
			...queuedDeliveryContext ? { deliveryContext: { ...queuedDeliveryContext } } : {}
		});
		requestHeartbeat({
			source: "restart-sentinel",
			intent: "immediate",
			reason: "wake",
			sessionKey: canonicalKey
		});
		return;
	}
	if (!params.entry.route) {
		enqueueSystemEvent(params.entry.message, {
			sessionKey: canonicalKey,
			...queuedDeliveryContext ? { deliveryContext: { ...queuedDeliveryContext } } : {}
		});
		requestHeartbeat({
			source: "restart-sentinel",
			intent: "immediate",
			reason: "wake",
			sessionKey: canonicalKey
		});
		return;
	}
	const route = params.entry.route;
	const messageId = resolveQueuedRestartContinuationMessageId(params.entry);
	const userMessage = params.entry.message.trim();
	const agentId = resolveSessionAgentId({
		sessionKey: canonicalKey,
		config: cfg
	});
	let dispatchError;
	const ctxPayload = finalizeInboundContext({
		Body: userMessage,
		BodyForAgent: injectTimestamp(userMessage, timestampOptsFromConfig(cfg)),
		BodyForCommands: "",
		RawBody: userMessage,
		CommandBody: "",
		SessionKey: canonicalKey,
		AccountId: route.accountId,
		MessageSid: messageId,
		Timestamp: Date.now(),
		InputProvenance: {
			kind: "internal_system",
			sourceChannel: route.channel,
			sourceTool: "restart-sentinel"
		},
		Provider: INTERNAL_MESSAGE_CHANNEL,
		Surface: INTERNAL_MESSAGE_CHANNEL,
		ChatType: route.chatType,
		CommandAuthorized: true,
		GatewayClientScopes: ["operator.admin"],
		ReplyToId: route.replyToId,
		OriginatingChannel: route.channel,
		OriginatingTo: route.to,
		ExplicitDeliverRoute: true,
		MessageThreadId: route.threadId
	}, {
		forceBodyForCommands: true,
		forceChatType: true
	});
	await dispatchAssembledChannelTurn({
		cfg,
		channel: route.channel,
		accountId: route.accountId,
		agentId,
		routeSessionKey: canonicalKey,
		storePath,
		ctxPayload,
		recordInboundSession,
		dispatchReplyWithBufferedBlockDispatcher,
		delivery: {
			preparePayload: (payload) => {
				if (isRestartContinuationBusyPayload(payload)) throw new Error(RESTART_CONTINUATION_BUSY_RETRY_ERROR);
				return resolveRestartContinuationOutboundPayload({
					payload,
					messageId,
					replyToId: route.replyToId
				});
			},
			durable: (_payload, info) => info.kind === "final" ? {
				to: route.to,
				replyToId: route.replyToId,
				threadId: route.threadId,
				deps: params.deps
			} : false,
			deliver: async (payload) => {
				const send = await sendDurableMessageBatch({
					cfg,
					channel: route.channel,
					to: route.to,
					accountId: route.accountId,
					replyToId: route.replyToId,
					threadId: route.threadId,
					payloads: [payload],
					session: buildOutboundSessionContext({
						cfg,
						sessionKey: canonicalKey
					}),
					deps: params.deps,
					bestEffort: false
				});
				if (send.status === "failed" || send.status === "partial_failed") throw send.error;
				if ((send.status === "sent" ? send.results : []).length === 0) throw new Error("restart continuation delivery returned no results");
			},
			onError: (err, info) => {
				dispatchError ??= err;
				log.warn(`restart continuation dispatch failed during ${info.kind}: ${String(err)}`, { sessionKey: canonicalKey });
			}
		},
		record: { onRecordError: (err) => {
			log.warn(`restart continuation failed to record inbound session metadata: ${String(err)}`, { sessionKey: canonicalKey });
		} }
	});
	if (dispatchError) throw dispatchError;
}
function buildQueuedRestartContinuation(params) {
	const idempotencyKey = buildRestartContinuationMessageId({
		sessionKey: params.sessionKey,
		kind: params.continuation.kind,
		ts: params.ts
	});
	if (params.continuation.kind === "systemEvent") return {
		kind: "systemEvent",
		sessionKey: params.sessionKey,
		text: params.continuation.text,
		...params.deliveryContext ? { deliveryContext: params.deliveryContext } : {},
		idempotencyKey,
		maxRetries: RESTART_CONTINUATION_BUSY_MAX_ATTEMPTS
	};
	return {
		kind: "agentTurn",
		sessionKey: params.sessionKey,
		message: params.continuation.message,
		messageId: idempotencyKey,
		maxRetries: RESTART_CONTINUATION_BUSY_MAX_ATTEMPTS,
		...params.route ? { route: params.route } : {},
		...params.deliveryContext ? { deliveryContext: params.deliveryContext } : {},
		idempotencyKey
	};
}
async function drainRestartContinuationQueue(params) {
	for (let attempt = 1; attempt <= RESTART_CONTINUATION_BUSY_MAX_ATTEMPTS; attempt += 1) {
		await drainPendingSessionDeliveries({
			drainKey: `restart-continuation:${params.entryId}`,
			logLabel: "restart continuation",
			log: params.log,
			deliver: (entry) => deliverQueuedSessionDelivery({
				deps: params.deps,
				entry
			}),
			selectEntry: (entry) => ({
				match: entry.id === params.entryId,
				bypassBackoff: true
			})
		});
		if (!isRestartContinuationBusyRetry(await loadPendingSessionDelivery(params.entryId))) return;
		if (attempt >= RESTART_CONTINUATION_BUSY_MAX_ATTEMPTS) return;
		params.log.info(`restart continuation: entry ${params.entryId} still waiting for the previous run to clear; retrying in ${RESTART_CONTINUATION_BUSY_RETRY_DELAY_MS}ms`);
		await waitForOutboundRetry(RESTART_CONTINUATION_BUSY_RETRY_DELAY_MS);
	}
}
async function recoverPendingRestartContinuationDeliveries(params) {
	await recoverPendingSessionDeliveries({
		deliver: (entry) => deliverQueuedSessionDelivery({
			deps: params.deps,
			entry
		}),
		log: params.log ?? log,
		maxEnqueuedAt: params.maxEnqueuedAt
	});
}
async function loadRestartSentinelStartupTask(params) {
	const sentinel = await readRestartSentinel();
	if (!sentinel) return null;
	const sentinelPath = resolveRestartSentinelPath();
	const payload = sentinel.payload;
	const sessionKey = payload.sessionKey?.trim();
	const message = formatRestartSentinelMessage(payload);
	const summary = summarizeRestartSentinel(payload);
	const wakeDeliveryContext = mergeDeliveryContext(payload.threadId != null ? {
		...payload.deliveryContext,
		threadId: payload.threadId
	} : payload.deliveryContext, void 0);
	const run = async () => {
		if (isPendingControlPlaneUpdateRestartSentinel(payload)) {
			const attempt = params.attempt ?? 0;
			if (attempt < CONTROL_PLANE_UPDATE_PENDING_MAX_ATTEMPTS) {
				setTimeout(() => {
					scheduleRestartSentinelWakeAttempt({
						deps: params.deps,
						attempt: attempt + 1
					}).catch((err) => {
						log.warn(`restart sentinel pending update retry failed: ${formatErrorMessage(err)}`);
					});
				}, CONTROL_PLANE_UPDATE_PENDING_RETRY_DELAY_MS).unref?.();
				return {
					status: "skipped",
					reason: "update-restart-pending"
				};
			}
			log.warn(`${summary}: update restart sentinel remained pending after retry window`, {
				sessionKey,
				reason: payload.stats?.reason ?? null
			});
		}
		if (!sessionKey) {
			const mainSessionKey = resolveMainSessionKeyFromConfig();
			enqueueSystemEvent(message, { sessionKey: mainSessionKey });
			if (payload.continuation) log.warn(`${summary}: continuation skipped: restart sentinel sessionKey unavailable`, {
				sessionKey: mainSessionKey,
				continuationKind: payload.continuation.kind
			});
			await removeRestartSentinelFile(sentinelPath);
			return { status: "ran" };
		}
		const { baseSessionKey, threadId: sessionThreadId } = parseSessionThreadInfo(sessionKey);
		const { cfg, entry, canonicalKey } = loadSessionEntry(sessionKey);
		const sentinelContext = payload.deliveryContext;
		let sessionDeliveryContext = deliveryContextFromSession(entry);
		let chatType = entry?.origin?.chatType ?? "direct";
		if (!hasRoutableDeliveryContext(sessionDeliveryContext) && baseSessionKey && baseSessionKey !== sessionKey) {
			const { entry: baseEntry } = loadSessionEntry(baseSessionKey);
			chatType = entry?.origin?.chatType ?? baseEntry?.origin?.chatType ?? "direct";
			sessionDeliveryContext = mergeDeliveryContext(sessionDeliveryContext, deliveryContextFromSession(baseEntry));
		}
		const origin = mergeDeliveryContext(sentinelContext, sessionDeliveryContext);
		const channelRaw = origin?.channel;
		const channel = channelRaw ? normalizeChannelId(channelRaw) : null;
		const to = origin?.to;
		const threadId = payload.threadId ?? sessionThreadId ?? (origin?.threadId != null ? stringifyRouteThreadId(origin.threadId) : void 0);
		let resolvedTo;
		let replyToId;
		let resolvedThreadId = threadId;
		let continuationQueueId;
		let continuationRoute;
		if (channel && to) {
			const resolved = resolveOutboundTarget({
				channel,
				to,
				cfg,
				accountId: origin?.accountId,
				mode: "implicit"
			});
			if (resolved.ok) {
				resolvedTo = resolved.to;
				const replyTransport = getChannelPlugin(channel)?.threading?.resolveReplyTransport?.({
					cfg,
					accountId: origin?.accountId,
					threadId
				}) ?? null;
				replyToId = replyTransport?.replyToId ?? void 0;
				resolvedThreadId = replyTransport && Object.hasOwn(replyTransport, "threadId") ? replyTransport.threadId != null ? stringifyRouteThreadId(replyTransport.threadId) : void 0 : threadId;
			}
		}
		if (payload.continuation) {
			continuationRoute = resolveRestartContinuationRoute({
				channel: channel ?? void 0,
				to: resolvedTo,
				accountId: origin?.accountId,
				replyToId,
				threadId: resolvedThreadId,
				chatType
			});
			continuationQueueId = await enqueueSessionDelivery(buildQueuedRestartContinuation({
				sessionKey: canonicalKey,
				continuation: payload.continuation,
				ts: payload.ts,
				route: continuationRoute,
				deliveryContext: resolvedTo && channel ? {
					channel,
					to: resolvedTo,
					...origin?.accountId ? { accountId: origin.accountId } : {},
					...resolvedThreadId ? { threadId: resolvedThreadId } : {}
				} : wakeDeliveryContext
			}));
		}
		await removeRestartSentinelFile(sentinelPath);
		if (!(payload.continuation?.kind === "agentTurn" && continuationRoute !== void 0)) enqueueRestartSentinelWake(message, sessionKey, wakeDeliveryContext);
		if (resolvedTo && channel) {
			const outboundSession = buildOutboundSessionContext({
				cfg,
				sessionKey: canonicalKey
			});
			await deliverRestartSentinelNotice({
				deps: params.deps,
				cfg,
				sessionKey: canonicalKey,
				summary,
				message,
				channel,
				to: resolvedTo,
				accountId: origin?.accountId,
				replyToId,
				threadId: resolvedThreadId,
				session: outboundSession
			});
		}
		if (continuationQueueId) await drainRestartContinuationQueue({
			deps: params.deps,
			entryId: continuationQueueId,
			log
		});
		return { status: "ran" };
	};
	return {
		source: "restart-sentinel",
		...sessionKey ? { sessionKey } : {},
		run
	};
}
async function scheduleRestartSentinelWakeAttempt(params) {
	const task = await loadRestartSentinelStartupTask(params);
	if (!task) return;
	await runStartupTasks({
		tasks: [task],
		log
	});
}
async function scheduleRestartSentinelWake(params) {
	await scheduleRestartSentinelWakeAttempt({
		...params,
		attempt: 0
	});
}
async function refreshLatestUpdateRestartSentinel() {
	const sentinel = await finalizeUpdateRestartSentinelRunningVersion() ?? await readRestartSentinel();
	if (sentinel?.payload.kind === "update") latestUpdateRestartSentinel = cloneRestartSentinelPayload(sentinel.payload);
	return cloneRestartSentinelPayload(latestUpdateRestartSentinel);
}
function getLatestUpdateRestartSentinel() {
	return cloneRestartSentinelPayload(latestUpdateRestartSentinel);
}
function recordLatestUpdateRestartSentinel(payload) {
	latestUpdateRestartSentinel = cloneRestartSentinelPayload(payload);
}
//#endregion
export { scheduleRestartSentinelWake as a, refreshLatestUpdateRestartSentinel as i, recordLatestUpdateRestartSentinel as n, recoverPendingRestartContinuationDeliveries as r, getLatestUpdateRestartSentinel as t };
