import { i as formatErrorMessage } from "./errors-QN8rySzW.js";
import { p as resolveSessionAgentId } from "./agent-scope-eOlEQiLx.js";
import { t as createSubsystemLogger } from "./subsystem-Dacyw1co.js";
import { h as stringifyRouteThreadId } from "./channel-route-DT81F24Z.js";
import { r as mergeDeliveryContext, t as deliveryContextFromSession } from "./delivery-context.shared-DqCZXuxt.js";
import { u as parseSessionThreadInfo } from "./store-load-u3EktAq0.js";
import { a as normalizeChannelId, t as getChannelPlugin } from "./registry-BkfWr-Uk.js";
import "./plugins-ChY-kMXQ.js";
import { c as resolveMainSessionKeyFromConfig } from "./sessions-CiMlHWga.js";
import { c as loadSessionEntry } from "./session-utils-EvD7NRX-.js";
import { t as deliverOutboundPayloads } from "./deliver-CCQW_Dx5.js";
import { o as requestHeartbeat } from "./heartbeat-wake-ObqI4o0x.js";
import { a as enqueueSessionDelivery } from "./targeting-4VeOvYYT.js";
import { a as enqueueSystemEvent } from "./system-events-BjJbC-Fg.js";
import { c as resolveRestartSentinelPath, i as formatRestartSentinelMessage, l as summarizeRestartSentinel, n as finalizeUpdateRestartSentinelRunningVersion, o as readRestartSentinel, s as removeRestartSentinelFile } from "./restart-sentinel-B_61XCsb.js";
import { c as enqueueDelivery, s as ackDelivery, u as failDelivery } from "./delivery-queue-Cx4ec-RI.js";
import { t as buildOutboundSessionContext } from "./session-context-Bd4VtqHH.js";
import { r as resolveOutboundTarget } from "./targets-CTszVdf0.js";
import { a as recoverPendingSessionDeliveries, i as drainPendingSessionDeliveries, t as deliverQueuedPostCompactionDelegate } from "./post-compaction-delegate-dispatch-Dtqw3pBf.js";
import { t as finalizeInboundContext } from "./inbound-context-b2ij61q1.js";
import { t as dispatchReplyWithBufferedBlockDispatcher } from "./provider-dispatcher-DXPWq5yU.js";
import { t as recordInboundSession } from "./session-CDaxTMui.js";
import { i as recordInboundSessionAndDispatchReply } from "./inbound-reply-dispatch-BCOdLV9x.js";
import { t as runStartupTasks } from "./startup-tasks-CLwD4C0e.js";
import { n as timestampOptsFromConfig, t as injectTimestamp } from "./agent-timestamp-Ddw10K6v.js";
//#region src/gateway/server-restart-sentinel.ts
const log = createSubsystemLogger("gateway/restart-sentinel");
const OUTBOUND_RETRY_DELAY_MS = 1e3;
const OUTBOUND_MAX_ATTEMPTS = 45;
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
		if ((await deliverOutboundPayloads({
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
		})).length > 0) {
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
	const messageId = params.entry.messageId;
	const userMessage = params.entry.message.trim();
	const agentId = resolveSessionAgentId({
		sessionKey: canonicalKey,
		config: cfg
	});
	let dispatchError;
	await recordInboundSessionAndDispatchReply({
		cfg,
		channel: route.channel,
		accountId: route.accountId,
		agentId,
		routeSessionKey: canonicalKey,
		storePath,
		ctxPayload: finalizeInboundContext({
			Body: userMessage,
			BodyForAgent: injectTimestamp(userMessage, timestampOptsFromConfig(cfg)),
			BodyForCommands: "",
			RawBody: userMessage,
			CommandBody: "",
			SessionKey: canonicalKey,
			AccountId: route.accountId,
			MessageSid: messageId,
			Timestamp: Date.now(),
			Provider: route.channel,
			Surface: route.channel,
			ChatType: route.chatType,
			CommandAuthorized: false,
			ReplyToId: route.replyToId,
			OriginatingChannel: route.channel,
			OriginatingTo: route.to,
			ExplicitDeliverRoute: true,
			MessageThreadId: route.threadId
		}, {
			forceBodyForCommands: true,
			forceChatType: true
		}),
		recordInboundSession,
		dispatchReplyWithBufferedBlockDispatcher,
		deliver: async (payload) => {
			const outboundPayload = resolveRestartContinuationOutboundPayload({
				payload,
				messageId,
				replyToId: route.replyToId
			});
			if ((await deliverOutboundPayloads({
				cfg,
				channel: route.channel,
				to: route.to,
				accountId: route.accountId,
				replyToId: route.replyToId,
				threadId: route.threadId,
				payloads: [outboundPayload],
				session: buildOutboundSessionContext({
					cfg,
					sessionKey: canonicalKey
				}),
				deps: params.deps,
				bestEffort: false
			})).length === 0) throw new Error("restart continuation delivery returned no results");
		},
		onRecordError: (err) => {
			log.warn(`restart continuation failed to record inbound session metadata: ${String(err)}`, { sessionKey: canonicalKey });
		},
		onDispatchError: (err) => {
			dispatchError ??= err;
		}
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
		idempotencyKey
	};
	return {
		kind: "agentTurn",
		sessionKey: params.sessionKey,
		message: params.continuation.message,
		messageId: idempotencyKey,
		...params.route ? { route: params.route } : {},
		...params.deliveryContext ? { deliveryContext: params.deliveryContext } : {},
		...params.continuation.traceparent ? { traceparent: params.continuation.traceparent } : {},
		idempotencyKey
	};
}
async function drainRestartContinuationQueue(params) {
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
		if (payload.continuation) continuationQueueId = await enqueueSessionDelivery(buildQueuedRestartContinuation({
			sessionKey: canonicalKey,
			continuation: payload.continuation,
			ts: payload.ts,
			route: resolveRestartContinuationRoute({
				channel: channel ?? void 0,
				to: resolvedTo,
				accountId: origin?.accountId,
				replyToId,
				threadId: resolvedThreadId,
				chatType
			}),
			deliveryContext: resolvedTo && channel ? {
				channel,
				to: resolvedTo,
				...origin?.accountId ? { accountId: origin.accountId } : {},
				...resolvedThreadId ? { threadId: resolvedThreadId } : {}
			} : wakeDeliveryContext
		}));
		await removeRestartSentinelFile(sentinelPath);
		enqueueRestartSentinelWake(message, sessionKey, wakeDeliveryContext);
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
async function scheduleRestartSentinelWake(params) {
	const task = await loadRestartSentinelStartupTask(params);
	if (!task) return;
	await runStartupTasks({
		tasks: [task],
		log
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
