import { i as formatErrorMessage } from "./errors-ixwfrboQ.js";
import { _ as resolveSessionAgentId } from "./agent-scope-rw2bYM9R.js";
import { t as createSubsystemLogger } from "./subsystem-BCvJ25zm.js";
import { r as INTERNAL_MESSAGE_CHANNEL } from "./message-channel-core-CNnWDHPu.js";
import "./message-channel-DJtqYoTD.js";
import { h as stringifyRouteThreadId } from "./channel-route-DBqK_NgW.js";
import { r as mergeDeliveryContext, t as deliveryContextFromSession } from "./delivery-context.shared-CPgWum5w.js";
import { S as parseSessionThreadInfo } from "./store-load-D4UxZlJL.js";
import { a as normalizeChannelId, t as getChannelPlugin } from "./registry-BstTfco-.js";
import "./plugins-3tO_yYSp.js";
import { l as resolveMainSessionKeyFromConfig } from "./sessions-CEmQfc29.js";
import { c as loadSessionEntry } from "./session-utils-ByrcSMqc.js";
import { o as requestHeartbeat } from "./heartbeat-wake-CLbjIH9m.js";
import { a as enqueueSystemEvent } from "./system-events-CvlpBn9J.js";
import { o as loadPendingSessionDelivery, r as enqueueSessionDelivery } from "./session-delivery-queue-storage-BKJP2MpR.js";
import { c as resolveRestartSentinelPath, i as formatRestartSentinelMessage, l as summarizeRestartSentinel, n as finalizeUpdateRestartSentinelRunningVersion, o as readRestartSentinel, s as removeRestartSentinelFile } from "./restart-sentinel-BhyggOf6.js";
import { t as buildOutboundSessionContext } from "./session-context-iNI6dgM2.js";
import { c as enqueueDelivery, s as ackDelivery, u as failDelivery } from "./delivery-queue-0WkqK4cs.js";
import { t as sendDurableMessageBatch } from "./send-CLo2v9dN.js";
import "./runtime-B2UK7A6a.js";
import { r as resolveOutboundTarget } from "./targets-BmtmASdP.js";
import "./get-reply-run-queue-CAbjyH0E.js";
import { l as drainPendingSessionDeliveries, r as deliverQueuedPostCompactionDelegate, u as recoverPendingSessionDeliveries } from "./post-compaction-delegate-dispatch-BD0Cc4Hr.js";
import { t as finalizeInboundContext } from "./inbound-context-1BxuQtGw.js";
import { t as dispatchReplyWithBufferedBlockDispatcher } from "./provider-dispatcher-5x4YEy-U.js";
import { t as recordInboundSession } from "./session-D7dh-kcF.js";
import { n as dispatchAssembledChannelTurn } from "./kernel-C8rPaw0h.js";
import { t as runStartupTasks } from "./startup-tasks-BrDqSQQ7.js";
import { n as timestampOptsFromConfig, t as injectTimestamp } from "./agent-timestamp-B8bEJWag.js";
import { a as isPendingControlPlaneUpdateRestartSentinel } from "./update-control-plane-sentinel-BCfQ6Khs.js";
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
	if (params.entry.kind === "postCompactionDelegate") {
		await deliverQueuedPostCompactionDelegate({ entry: {
			...params.entry,
			sessionKey: canonicalKey
		} });
		return;
	}
	if (params.entry.kind === "systemEvent") {
		enqueueSystemEvent(params.entry.text, {
			sessionKey: canonicalKey,
			...queuedDeliveryContext ? { deliveryContext: { ...queuedDeliveryContext } } : {},
			...params.entry.traceparent ? { traceparent: params.entry.traceparent } : {}
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
			...queuedDeliveryContext ? { deliveryContext: { ...queuedDeliveryContext } } : {},
			...params.entry.traceparent ? { traceparent: params.entry.traceparent } : {}
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
		...params.continuation.traceparent ? { traceparent: params.continuation.traceparent } : {},
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
		...params.continuation.traceparent ? { traceparent: params.continuation.traceparent } : {},
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
