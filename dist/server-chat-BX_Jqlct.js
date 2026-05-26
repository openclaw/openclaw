import { n as detectErrorKind } from "./errors-b3ZrCRlt.js";
import { a as isSubagentSessionKey, n as isAcpSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { g as normalizeVerboseLevel } from "./thinking-DNSlsULp.js";
import { r as setSafeTimeout } from "./timer-delay-awNPCchy.js";
import { c as getAgentRunContext } from "./agent-events-BuYtWSh4.js";
import { d as updateSessionStoreEntry } from "./store-BmtchQvp.js";
import "./sessions-CQHHcgC_.js";
import { c as loadSessionEntry, s as loadGatewaySessionRow } from "./session-utils-CRKr-5AU.js";
import { d as stripHeartbeatToken } from "./heartbeat-6oYmHVVQ.js";
import { a as resolveToolSearchCodeDisplayTarget } from "./tool-display-common-D5L_bf7a.js";
import { t as resolveHeartbeatVisibility } from "./heartbeat-visibility-3WEdkb8M.js";
import { t as formatForLog } from "./ws-log-Ds39xp21.js";
import { i as shouldSuppressAssistantEventForLiveChat, n as projectLiveAssistantBufferedText, r as resolveMergedAssistantText, t as normalizeLiveAssistantEventText } from "./live-chat-projector-BZb_1Q8c.js";
import { a as createToolEventRecipientRegistry, i as createSessionMessageSubscriberRegistry, n as createChatRunState, r as createSessionEventSubscriberRegistry, t as createChatRunRegistry } from "./server-chat-state-5p6_r5uT.js";
//#region src/gateway/session-lifecycle-state.ts
function isFiniteTimestamp(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function resolveLifecyclePhase(event) {
	const phase = typeof event.data?.phase === "string" ? event.data.phase : "";
	return phase === "start" || phase === "end" || phase === "error" ? phase : null;
}
function resolveTerminalStatus(event) {
	if (resolveLifecyclePhase(event) === "error") return "failed";
	if ((typeof event.data?.stopReason === "string" ? event.data.stopReason : "") === "aborted") return "killed";
	return event.data?.aborted === true ? "timeout" : "done";
}
function resolveLifecycleStartedAt(existingStartedAt, event) {
	if (isFiniteTimestamp(event.data?.startedAt)) return event.data.startedAt;
	if (isFiniteTimestamp(existingStartedAt)) return existingStartedAt;
	return isFiniteTimestamp(event.ts) ? event.ts : void 0;
}
function resolveLifecycleEndedAt(event) {
	if (isFiniteTimestamp(event.data?.endedAt)) return event.data.endedAt;
	return isFiniteTimestamp(event.ts) ? event.ts : void 0;
}
function resolveRuntimeMs(params) {
	const { startedAt, endedAt, existingRuntimeMs } = params;
	if (isFiniteTimestamp(startedAt) && isFiniteTimestamp(endedAt)) return Math.max(0, endedAt - startedAt);
	if (typeof existingRuntimeMs === "number" && Number.isFinite(existingRuntimeMs) && existingRuntimeMs >= 0) return existingRuntimeMs;
}
function deriveGatewaySessionLifecycleSnapshot(params) {
	const phase = resolveLifecyclePhase(params.event);
	if (!phase) return {};
	const existing = params.session ?? void 0;
	if (phase === "start") {
		const startedAt = resolveLifecycleStartedAt(existing?.startedAt, params.event);
		return {
			updatedAt: startedAt ?? existing?.updatedAt,
			status: "running",
			startedAt,
			endedAt: void 0,
			runtimeMs: void 0,
			abortedLastRun: false
		};
	}
	const startedAt = resolveLifecycleStartedAt(existing?.startedAt, params.event);
	const endedAt = resolveLifecycleEndedAt(params.event);
	return {
		updatedAt: endedAt ?? existing?.updatedAt,
		status: resolveTerminalStatus(params.event),
		startedAt,
		endedAt,
		runtimeMs: resolveRuntimeMs({
			startedAt,
			endedAt,
			existingRuntimeMs: existing?.runtimeMs
		}),
		abortedLastRun: resolveTerminalStatus(params.event) === "killed"
	};
}
function derivePersistedSessionLifecyclePatch(params) {
	const snapshot = deriveGatewaySessionLifecycleSnapshot({
		session: params.entry ?? void 0,
		event: params.event
	});
	return {
		...snapshot,
		updatedAt: typeof snapshot.updatedAt === "number" ? snapshot.updatedAt : void 0
	};
}
async function persistGatewaySessionLifecycleEvent(params) {
	if (!resolveLifecyclePhase(params.event)) return;
	const sessionEntry = loadSessionEntry(params.sessionKey);
	if (!sessionEntry.entry) return;
	await updateSessionStoreEntry({
		storePath: sessionEntry.storePath,
		sessionKey: sessionEntry.canonicalKey,
		update: async (entry) => derivePersistedSessionLifecyclePatch({
			entry,
			event: params.event
		})
	});
}
//#endregion
//#region src/gateway/server-chat.ts
function projectToolSearchCodeEventForChannelPayload(payload) {
	const data = payload.data;
	if (!data || typeof data !== "object") return payload;
	const record = data;
	if (record.name !== "tool_search_code") return payload;
	const target = resolveToolSearchCodeDisplayTarget(record.args);
	if (!target) return payload;
	const projectedName = target.displayToolName ?? target.toolName;
	if (!projectedName || projectedName === "tool_search_code") return payload;
	const projectedData = {
		...record,
		name: projectedName
	};
	if (target.displayArgs) projectedData.args = target.displayArgs;
	else if (target.detail) projectedData.args = { detail: target.detail };
	if (target.bridgeVerb) {
		projectedData.bridgeToolName = "tool_search_code";
		projectedData.bridgeTargetToolName = target.toolName;
		projectedData.bridgeVerb = target.bridgeVerb;
	}
	return {
		...payload,
		data: projectedData
	};
}
function resolveHeartbeatAckMaxChars() {
	try {
		const cfg = getRuntimeConfig();
		return Math.max(0, cfg.agents?.defaults?.heartbeat?.ackMaxChars ?? 300);
	} catch {
		return 300;
	}
}
function resolveHeartbeatContext(runId, sourceRunId) {
	const primary = getAgentRunContext(runId);
	if (primary?.isHeartbeat) return primary;
	if (sourceRunId && sourceRunId !== runId) {
		const source = getAgentRunContext(sourceRunId);
		if (source?.isHeartbeat) return source;
	}
	return primary;
}
/**
* Check if heartbeat ACK/noise should be hidden from interactive chat surfaces.
*/
function shouldHideHeartbeatChatOutput(runId, sourceRunId) {
	if (!resolveHeartbeatContext(runId, sourceRunId)?.isHeartbeat) return false;
	try {
		return !resolveHeartbeatVisibility({
			cfg: getRuntimeConfig(),
			channel: "webchat"
		}).showOk;
	} catch {
		return true;
	}
}
function shouldSuppressHeartbeatToolEvents(runId, sourceRunId) {
	return Boolean(resolveHeartbeatContext(runId, sourceRunId)?.isHeartbeat);
}
function normalizeHeartbeatChatFinalText(params) {
	if (!shouldHideHeartbeatChatOutput(params.runId, params.sourceRunId)) return {
		suppress: false,
		text: params.text
	};
	const stripped = stripHeartbeatToken(params.text, {
		mode: "heartbeat",
		maxAckChars: resolveHeartbeatAckMaxChars()
	});
	if (!stripped.didStrip) return {
		suppress: false,
		text: params.text
	};
	if (stripped.shouldSkip) return {
		suppress: true,
		text: ""
	};
	return {
		suppress: false,
		text: stripped.text
	};
}
/**
* Keep this aligned with the agent.wait lifecycle-error grace so chat surfaces
* do not finalize a run before fallback or retry reuses the same runId.
*/
const AGENT_LIFECYCLE_ERROR_RETRY_GRACE_MS = 15e3;
const CHAT_ERROR_KINDS = new Set([
	"refusal",
	"timeout",
	"rate_limit",
	"context_length",
	"unknown"
]);
function readChatErrorKind(value) {
	return typeof value === "string" && CHAT_ERROR_KINDS.has(value) ? value : void 0;
}
function resolveBroadcastDelta(params) {
	if (!params.text) return;
	const previous = params.previousBroadcastText;
	if (previous === void 0) return { deltaText: params.text };
	if (!params.text.startsWith(previous)) return {
		deltaText: params.text,
		replace: true
	};
	const deltaText = params.text.slice(previous.length);
	return deltaText ? { deltaText } : void 0;
}
function createAgentEventHandler({ broadcast, broadcastToConnIds, nodeSendToSession, agentRunSeq, chatRunState, resolveSessionKeyForRun, clearAgentRunContext, toolEventRecipients, sessionEventSubscribers, loadGatewaySessionRowForSnapshot = loadGatewaySessionRow, lifecycleErrorRetryGraceMs = AGENT_LIFECYCLE_ERROR_RETRY_GRACE_MS, isChatSendRunActive = () => false }) {
	const pendingTerminalLifecycleErrors = /* @__PURE__ */ new Map();
	const agentTextThrottleKey = (clientRunId, stream) => `${clientRunId}:${stream}`;
	const agentTextThrottleKeys = (clientRunId) => [
		clientRunId,
		agentTextThrottleKey(clientRunId, "assistant"),
		agentTextThrottleKey(clientRunId, "thinking")
	];
	const clearAgentTextThrottleState = (clientRunId) => {
		for (const key of agentTextThrottleKeys(clientRunId)) {
			chatRunState.agentDeltaSentAt.delete(key);
			chatRunState.bufferedAgentEvents.delete(key);
		}
	};
	const clearBufferedChatState = (clientRunId) => {
		chatRunState.rawBuffers.delete(clientRunId);
		chatRunState.buffers.delete(clientRunId);
		chatRunState.deltaSentAt.delete(clientRunId);
		chatRunState.deltaLastBroadcastLen.delete(clientRunId);
		chatRunState.deltaLastBroadcastText.delete(clientRunId);
		clearAgentTextThrottleState(clientRunId);
	};
	const clearPendingTerminalLifecycleError = (runId) => {
		const pending = pendingTerminalLifecycleErrors.get(runId);
		if (!pending) return;
		clearTimeout(pending.timer);
		pendingTerminalLifecycleErrors.delete(runId);
	};
	const spawnedByCache = /* @__PURE__ */ new Map();
	const resolveSpawnedBy = (sessionKey) => {
		if (spawnedByCache.has(sessionKey)) return spawnedByCache.get(sessionKey);
		if (!isSubagentSessionKey(sessionKey) && !isAcpSessionKey(sessionKey)) return null;
		let result = null;
		try {
			result = loadGatewaySessionRow(sessionKey)?.spawnedBy ?? null;
		} catch {}
		spawnedByCache.set(sessionKey, result);
		return result;
	};
	const buildSessionEventSnapshot = (sessionKey, evt) => {
		const row = loadGatewaySessionRowForSnapshot(sessionKey);
		const lifecyclePatch = evt ? deriveGatewaySessionLifecycleSnapshot({
			session: row ? {
				updatedAt: row.updatedAt ?? void 0,
				status: row.status,
				startedAt: row.startedAt,
				endedAt: row.endedAt,
				runtimeMs: row.runtimeMs,
				abortedLastRun: row.abortedLastRun
			} : void 0,
			event: evt
		}) : {};
		const session = row ? {
			...row,
			...lifecyclePatch
		} : void 0;
		const snapshotSource = session ?? lifecyclePatch;
		return {
			...session ? { session } : {},
			updatedAt: snapshotSource.updatedAt,
			sessionId: row?.sessionId,
			kind: row?.kind,
			channel: row?.channel,
			subject: row?.subject,
			groupChannel: row?.groupChannel,
			space: row?.space,
			chatType: row?.chatType,
			origin: row?.origin,
			spawnedBy: row?.spawnedBy,
			spawnedWorkspaceDir: row?.spawnedWorkspaceDir,
			forkedFromParent: row?.forkedFromParent,
			spawnDepth: row?.spawnDepth,
			subagentRole: row?.subagentRole,
			subagentControlScope: row?.subagentControlScope,
			label: row?.label,
			displayName: row?.displayName,
			deliveryContext: row?.deliveryContext,
			parentSessionKey: row?.parentSessionKey,
			childSessions: row?.childSessions,
			thinkingLevel: row?.thinkingLevel,
			fastMode: row?.fastMode,
			verboseLevel: row?.verboseLevel,
			traceLevel: row?.traceLevel,
			reasoningLevel: row?.reasoningLevel,
			elevatedLevel: row?.elevatedLevel,
			sendPolicy: row?.sendPolicy,
			systemSent: row?.systemSent,
			inputTokens: row?.inputTokens,
			outputTokens: row?.outputTokens,
			lastChannel: row?.lastChannel,
			lastTo: row?.lastTo,
			lastAccountId: row?.lastAccountId,
			lastThreadId: row?.lastThreadId,
			totalTokens: row?.totalTokens,
			totalTokensFresh: row?.totalTokensFresh,
			contextTokens: row?.contextTokens,
			estimatedCostUsd: row?.estimatedCostUsd,
			responseUsage: row?.responseUsage,
			modelProvider: row?.modelProvider,
			model: row?.model,
			status: snapshotSource.status,
			startedAt: snapshotSource.startedAt,
			endedAt: snapshotSource.endedAt,
			runtimeMs: snapshotSource.runtimeMs,
			abortedLastRun: snapshotSource.abortedLastRun
		};
	};
	const finalizeLifecycleEvent = (evt, opts) => {
		const lifecyclePhase = evt.stream === "lifecycle" && typeof evt.data?.phase === "string" ? evt.data.phase : null;
		if (lifecyclePhase !== "end" && lifecyclePhase !== "error") return;
		clearPendingTerminalLifecycleError(evt.runId);
		const chatLink = chatRunState.registry.peek(evt.runId);
		const eventSessionKey = typeof evt.sessionKey === "string" && evt.sessionKey.trim() ? evt.sessionKey : void 0;
		const isControlUiVisible = getAgentRunContext(evt.runId)?.isControlUiVisible ?? true;
		const sessionKey = chatLink?.sessionKey ?? eventSessionKey ?? resolveSessionKeyForRun(evt.runId);
		const clientRunId = chatLink?.clientRunId ?? evt.runId;
		const eventRunId = chatLink?.clientRunId ?? evt.runId;
		const isAborted = chatRunState.abortedRuns.has(clientRunId) || chatRunState.abortedRuns.has(evt.runId);
		if (isControlUiVisible && sessionKey) if (!isAborted) {
			const evtStopReason = typeof evt.data?.stopReason === "string" ? evt.data.stopReason : void 0;
			const evtErrorKind = readChatErrorKind(evt.data?.errorKind) ?? detectErrorKind(evt.data?.error);
			if (chatLink) {
				const finished = chatRunState.registry.shift(evt.runId);
				if (!finished) {
					clearAgentRunContext(evt.runId);
					return;
				}
				if (!(opts?.skipChatErrorFinal && lifecyclePhase === "error")) emitChatFinal(finished.sessionKey, finished.clientRunId, evt.runId, evt.seq, lifecyclePhase === "error" ? "error" : "done", evt.data?.error, evtStopReason, evtErrorKind);
			} else if (!(opts?.skipChatErrorFinal && lifecyclePhase === "error")) emitChatFinal(sessionKey, eventRunId, evt.runId, evt.seq, lifecyclePhase === "error" ? "error" : "done", evt.data?.error, evtStopReason, evtErrorKind);
		} else {
			clearBufferedChatState(clientRunId);
			if (chatLink) chatRunState.registry.remove(evt.runId, clientRunId, sessionKey);
		}
		toolEventRecipients.markFinal(evt.runId);
		clearBufferedChatState(clientRunId);
		clearAgentRunContext(evt.runId);
		agentRunSeq.delete(evt.runId);
		agentRunSeq.delete(clientRunId);
		if (sessionKey) {
			persistGatewaySessionLifecycleEvent({
				sessionKey,
				event: evt
			}).catch(() => void 0);
			const sessionEventConnIds = sessionEventSubscribers.getAll();
			if (sessionEventConnIds.size > 0) broadcastToConnIds("sessions.changed", {
				sessionKey,
				phase: lifecyclePhase,
				runId: evt.runId,
				...eventRunId !== evt.runId ? { clientRunId: eventRunId } : {},
				ts: evt.ts,
				...buildSessionEventSnapshot(sessionKey, evt)
			}, sessionEventConnIds, { dropIfSlow: true });
		}
	};
	const scheduleTerminalLifecycleError = (evt, opts) => {
		clearPendingTerminalLifecycleError(evt.runId);
		const timer = setSafeTimeout(() => {
			const pending = pendingTerminalLifecycleErrors.get(evt.runId);
			if (!pending || pending.timer !== timer) return;
			pendingTerminalLifecycleErrors.delete(evt.runId);
			finalizeLifecycleEvent(pending.event, pending.opts);
		}, lifecycleErrorRetryGraceMs);
		timer.unref?.();
		pendingTerminalLifecycleErrors.set(evt.runId, {
			timer,
			event: evt,
			opts
		});
	};
	const emitChatDelta = (sessionKey, clientRunId, sourceRunId, seq, text, delta) => {
		const cleaned = normalizeLiveAssistantEventText({
			text,
			delta
		});
		const mergedRawText = resolveMergedAssistantText({
			previousText: chatRunState.rawBuffers.get(clientRunId) ?? "",
			nextText: cleaned.text,
			nextDelta: cleaned.delta
		});
		if (!mergedRawText) return;
		chatRunState.rawBuffers.set(clientRunId, mergedRawText);
		const projected = projectLiveAssistantBufferedText(mergedRawText);
		const mergedText = projected.text;
		chatRunState.buffers.set(clientRunId, mergedText);
		if (projected.suppress) return;
		if (shouldHideHeartbeatChatOutput(clientRunId, sourceRunId)) return;
		const now = Date.now();
		if (now - (chatRunState.deltaSentAt.get(clientRunId) ?? 0) < 150) return;
		const broadcastDelta = resolveBroadcastDelta({
			text: mergedText,
			previousBroadcastText: chatRunState.deltaLastBroadcastText.get(clientRunId)
		});
		if (!broadcastDelta) return;
		chatRunState.deltaSentAt.set(clientRunId, now);
		chatRunState.deltaLastBroadcastLen.set(clientRunId, mergedText.length);
		chatRunState.deltaLastBroadcastText.set(clientRunId, mergedText);
		const spawnedBy = resolveSpawnedBy(sessionKey);
		const payload = {
			runId: clientRunId,
			sessionKey,
			...spawnedBy && { spawnedBy },
			seq,
			state: "delta",
			deltaText: broadcastDelta.deltaText,
			...broadcastDelta.replace ? { replace: true } : {},
			message: {
				role: "assistant",
				content: [{
					type: "text",
					text: mergedText
				}],
				timestamp: now
			}
		};
		broadcast("chat", payload, { dropIfSlow: true });
		nodeSendToSession(sessionKey, "chat", payload);
	};
	const resolveBufferedChatTextState = (clientRunId, sourceRunId, options) => {
		const normalizedHeartbeatText = normalizeHeartbeatChatFinalText({
			runId: clientRunId,
			sourceRunId,
			text: normalizeLiveAssistantEventText({ text: chatRunState.buffers.get(clientRunId) ?? "" }).text.trim()
		});
		const projected = projectLiveAssistantBufferedText(normalizedHeartbeatText.text.trim(), { suppressLeadFragments: options?.suppressLeadFragments });
		return {
			text: projected.text.trim(),
			shouldSuppressSilent: normalizedHeartbeatText.suppress || projected.suppress
		};
	};
	const flushBufferedChatDeltaIfNeeded = (sessionKey, clientRunId, sourceRunId, seq) => {
		const { text, shouldSuppressSilent } = resolveBufferedChatTextState(clientRunId, sourceRunId, { suppressLeadFragments: true });
		const shouldSuppressHeartbeatStreaming = shouldHideHeartbeatChatOutput(clientRunId, sourceRunId);
		if (!text || shouldSuppressSilent || shouldSuppressHeartbeatStreaming) return;
		const now = Date.now();
		const delta = resolveBroadcastDelta({
			text,
			previousBroadcastText: chatRunState.deltaLastBroadcastText.get(clientRunId)
		});
		if (!delta) return;
		const spawnedBy = resolveSpawnedBy(sessionKey);
		const flushPayload = {
			runId: clientRunId,
			sessionKey,
			...spawnedBy && { spawnedBy },
			seq,
			state: "delta",
			deltaText: delta.deltaText,
			...delta.replace ? { replace: true } : {},
			message: {
				role: "assistant",
				content: [{
					type: "text",
					text
				}],
				timestamp: now
			}
		};
		broadcast("chat", flushPayload, { dropIfSlow: true });
		nodeSendToSession(sessionKey, "chat", flushPayload);
		chatRunState.deltaLastBroadcastLen.set(clientRunId, text.length);
		chatRunState.deltaLastBroadcastText.set(clientRunId, text);
		chatRunState.deltaSentAt.set(clientRunId, now);
	};
	const emitChatFinal = (sessionKey, clientRunId, sourceRunId, seq, jobState, error, stopReason, errorKind) => {
		const { text, shouldSuppressSilent } = resolveBufferedChatTextState(clientRunId, sourceRunId, { suppressLeadFragments: false });
		flushBufferedChatDeltaIfNeeded(sessionKey, clientRunId, sourceRunId, seq);
		chatRunState.deltaLastBroadcastLen.delete(clientRunId);
		chatRunState.deltaLastBroadcastText.delete(clientRunId);
		chatRunState.rawBuffers.delete(clientRunId);
		chatRunState.buffers.delete(clientRunId);
		chatRunState.deltaSentAt.delete(clientRunId);
		clearAgentTextThrottleState(clientRunId);
		const spawnedBy = resolveSpawnedBy(sessionKey);
		if (jobState === "done") {
			const payload = {
				runId: clientRunId,
				sessionKey,
				...spawnedBy && { spawnedBy },
				seq,
				state: "final",
				...stopReason && { stopReason },
				message: text && !shouldSuppressSilent ? {
					role: "assistant",
					content: [{
						type: "text",
						text
					}],
					timestamp: Date.now()
				} : void 0
			};
			broadcast("chat", payload);
			nodeSendToSession(sessionKey, "chat", payload);
			return;
		}
		const payload = {
			runId: clientRunId,
			sessionKey,
			...spawnedBy && { spawnedBy },
			seq,
			state: "error",
			errorMessage: error ? formatForLog(error) : void 0,
			...errorKind && { errorKind }
		};
		broadcast("chat", payload);
		nodeSendToSession(sessionKey, "chat", payload);
	};
	const sendAgentPayload = (sessionKey, payload) => {
		broadcast("agent", payload);
		if (sessionKey) nodeSendToSession(sessionKey, "agent", payload);
	};
	const flushBufferedAgentDeltaIfNeeded = (clientRunId, stream) => {
		const bufferedEntries = (stream ? [agentTextThrottleKey(clientRunId, stream)] : agentTextThrottleKeys(clientRunId)).flatMap((key) => {
			const buffered = chatRunState.bufferedAgentEvents.get(key);
			if (!buffered) return [];
			return [{
				key,
				buffered
			}];
		});
		bufferedEntries.sort((a, b) => a.buffered.payload.seq - b.buffered.payload.seq);
		for (const { key, buffered } of bufferedEntries) {
			sendAgentPayload(buffered.sessionKey, buffered.payload);
			chatRunState.bufferedAgentEvents.delete(key);
			chatRunState.agentDeltaSentAt.set(key, Date.now());
		}
		return bufferedEntries.length > 0;
	};
	const resolveAgentTextThrottleStream = (evt) => {
		if (evt.stream === "assistant") return "assistant";
		if (evt.stream === "thinking") return "thinking";
		return null;
	};
	const isAgentTextThrottleEvent = (evt) => resolveAgentTextThrottleStream(evt) !== null && typeof evt.data?.text === "string";
	const shouldCoalesceAgentTextEvent = (evt) => isAgentTextThrottleEvent(evt) && typeof evt.data.delta === "string" && evt.data.delta.length > 0 && !(Array.isArray(evt.data.mediaUrls) && evt.data.mediaUrls.length > 0) && typeof evt.data.mediaUrl !== "string" && evt.data.replace !== true && (evt.stream !== "assistant" || !shouldSuppressAssistantEventForLiveChat(evt.data));
	const shouldAdvanceAgentTextThrottle = (evt) => isAgentTextThrottleEvent(evt) && (typeof evt.data.delta === "string" || evt.data.replace === true);
	const buildBufferedAgentEvent = (sessionKey, payload) => sessionKey ? {
		sessionKey,
		payload
	} : { payload };
	const mergeBufferedAgentPayload = (previous, next) => {
		if (previous.payload.stream !== next.payload.stream) return next;
		const previousDelta = previous.payload.data.delta;
		const nextDelta = next.payload.data.delta;
		if (typeof previousDelta !== "string" || typeof nextDelta !== "string") return next;
		return {
			...next,
			payload: {
				...next.payload,
				data: {
					...next.payload.data,
					delta: `${previousDelta}${nextDelta}`
				}
			}
		};
	};
	const sendOrBufferAgentTextEvent = (clientRunId, sessionKey, payload) => {
		const stream = resolveAgentTextThrottleStream(payload);
		if (!stream) {
			sendAgentPayload(sessionKey, payload);
			return;
		}
		const now = Date.now();
		const key = agentTextThrottleKey(clientRunId, stream);
		const last = chatRunState.agentDeltaSentAt.get(key);
		if (last !== void 0 && now - last < 150) {
			const nextBuffered = buildBufferedAgentEvent(sessionKey, payload);
			const buffered = chatRunState.bufferedAgentEvents.get(key);
			chatRunState.bufferedAgentEvents.set(key, buffered ? mergeBufferedAgentPayload(buffered, nextBuffered) : nextBuffered);
			return;
		}
		flushBufferedAgentDeltaIfNeeded(clientRunId);
		sendAgentPayload(sessionKey, payload);
		chatRunState.agentDeltaSentAt.set(key, now);
	};
	const resolveToolVerboseLevel = (runId, sessionKey) => {
		const runContext = getAgentRunContext(runId);
		const runVerbose = normalizeVerboseLevel(runContext?.verboseLevel);
		if (!sessionKey) return runVerbose ?? "off";
		try {
			const { cfg, entry } = loadSessionEntry(sessionKey);
			const sessionVerbose = normalizeVerboseLevel(entry?.verboseLevel);
			const sessionUpdatedAt = typeof entry?.updatedAt === "number" ? entry.updatedAt : void 0;
			const sessionChangedAfterRunStarted = sessionUpdatedAt !== void 0 && runContext?.registeredAt !== void 0 && sessionUpdatedAt >= runContext.registeredAt;
			if (sessionVerbose && (!runVerbose || sessionChangedAfterRunStarted)) return sessionVerbose;
			if (runVerbose) return runVerbose;
			return normalizeVerboseLevel(cfg.agents?.defaults?.verboseDefault) ?? "off";
		} catch {
			return runVerbose ?? "off";
		}
	};
	return (evt) => {
		const lifecyclePhase = evt.stream === "lifecycle" && typeof evt.data?.phase === "string" ? evt.data.phase : null;
		if (lifecyclePhase !== null && lifecyclePhase !== "error") clearPendingTerminalLifecycleError(evt.runId);
		const chatLink = chatRunState.registry.peek(evt.runId);
		const eventSessionKey = typeof evt.sessionKey === "string" && evt.sessionKey.trim() ? evt.sessionKey : void 0;
		const runContext = getAgentRunContext(evt.runId);
		const isControlUiVisible = runContext?.isControlUiVisible ?? true;
		const isHeartbeat = runContext?.isHeartbeat;
		const sessionKey = chatLink?.sessionKey ?? eventSessionKey ?? resolveSessionKeyForRun(evt.runId);
		const clientRunId = chatLink?.clientRunId ?? evt.runId;
		const eventRunId = chatLink?.clientRunId ?? evt.runId;
		const eventForClients = chatLink ? {
			...evt,
			runId: eventRunId
		} : evt;
		const isAborted = chatRunState.abortedRuns.has(clientRunId) || chatRunState.abortedRuns.has(evt.runId);
		const spawnedBy = sessionKey ? resolveSpawnedBy(sessionKey) : null;
		const agentPayload = sessionKey ? {
			...eventForClients,
			sessionKey,
			...spawnedBy && { spawnedBy },
			...isHeartbeat !== void 0 && { isHeartbeat }
		} : {
			...eventForClients,
			...isHeartbeat !== void 0 && { isHeartbeat }
		};
		const last = agentRunSeq.get(evt.runId) ?? 0;
		const isToolEvent = evt.stream === "tool";
		const isItemEvent = evt.stream === "item";
		const toolVerbose = isToolEvent ? resolveToolVerboseLevel(evt.runId, sessionKey) : "off";
		const suppressHeartbeatToolEvents = isToolEvent && shouldSuppressHeartbeatToolEvents(clientRunId, evt.runId);
		const shouldCoalesceAgentEvent = shouldCoalesceAgentTextEvent(evt);
		const channelToolPayload = isToolEvent && toolVerbose !== "full" ? (() => {
			const data = evt.data ? { ...evt.data } : {};
			delete data.result;
			delete data.partialResult;
			return {
				...agentPayload,
				data
			};
		})() : agentPayload;
		if (last > 0 && evt.seq !== last + 1 && isControlUiVisible) {
			flushBufferedAgentDeltaIfNeeded(clientRunId);
			broadcast("agent", {
				runId: eventRunId,
				stream: "error",
				ts: Date.now(),
				sessionKey,
				...spawnedBy && { spawnedBy },
				...isHeartbeat !== void 0 && { isHeartbeat },
				data: {
					reason: "seq gap",
					expected: last + 1,
					received: evt.seq
				}
			});
		}
		agentRunSeq.set(evt.runId, evt.seq);
		if (isToolEvent) {
			if ((typeof evt.data?.phase === "string" ? evt.data.phase : "") === "start" && isControlUiVisible && sessionKey && !isAborted && !suppressHeartbeatToolEvents) {
				flushBufferedChatDeltaIfNeeded(sessionKey, clientRunId, evt.runId, evt.seq);
				flushBufferedAgentDeltaIfNeeded(clientRunId);
			}
			const recipients = toolEventRecipients.get(evt.runId);
			if (isControlUiVisible && !suppressHeartbeatToolEvents && recipients && recipients.size > 0) broadcastToConnIds("agent", sessionKey ? {
				...agentPayload,
				...buildSessionEventSnapshot(sessionKey)
			} : agentPayload, recipients);
			if (isControlUiVisible && sessionKey && !suppressHeartbeatToolEvents) {
				const sessionSubscribers = sessionEventSubscribers.getAll();
				if (sessionSubscribers.size > 0) broadcastToConnIds("session.tool", {
					...agentPayload,
					...buildSessionEventSnapshot(sessionKey)
				}, sessionSubscribers, { dropIfSlow: true });
			}
		} else {
			if ((isItemEvent && typeof evt.data?.phase === "string" ? evt.data.phase : "") === "start" && isControlUiVisible && !isAborted) {
				if (sessionKey) flushBufferedChatDeltaIfNeeded(sessionKey, clientRunId, evt.runId, evt.seq);
				flushBufferedAgentDeltaIfNeeded(clientRunId);
			}
			if (isControlUiVisible) if (shouldCoalesceAgentEvent) sendOrBufferAgentTextEvent(clientRunId, sessionKey, agentPayload);
			else {
				flushBufferedAgentDeltaIfNeeded(clientRunId);
				sendAgentPayload(sessionKey, agentPayload);
				const textThrottleStream = resolveAgentTextThrottleStream(evt);
				if (textThrottleStream && shouldAdvanceAgentTextThrottle(evt)) chatRunState.agentDeltaSentAt.set(agentTextThrottleKey(clientRunId, textThrottleStream), Date.now());
			}
		}
		if (isControlUiVisible && sessionKey) {
			if (isToolEvent && !suppressHeartbeatToolEvents && toolVerbose !== "off") nodeSendToSession(sessionKey, "agent", projectToolSearchCodeEventForChannelPayload({
				...channelToolPayload,
				...buildSessionEventSnapshot(sessionKey)
			}));
			if (!isAborted && evt.stream === "assistant" && typeof evt.data?.text === "string" && !shouldSuppressAssistantEventForLiveChat(evt.data)) emitChatDelta(sessionKey, clientRunId, evt.runId, evt.seq, evt.data.text, evt.data.delta);
		}
		if (lifecyclePhase === "error") {
			clearBufferedChatState(clientRunId);
			const skipChatErrorFinal = isChatSendRunActive(evt.runId) && !chatLink;
			if (isAborted || lifecycleErrorRetryGraceMs <= 0) finalizeLifecycleEvent(evt, { skipChatErrorFinal });
			else scheduleTerminalLifecycleError(evt, { skipChatErrorFinal });
			return;
		}
		if (lifecyclePhase === "end") {
			finalizeLifecycleEvent(evt);
			return;
		}
		if (sessionKey && lifecyclePhase === "start") {
			persistGatewaySessionLifecycleEvent({
				sessionKey,
				event: evt
			}).catch(() => void 0);
			const sessionEventConnIds = sessionEventSubscribers.getAll();
			if (sessionEventConnIds.size > 0) broadcastToConnIds("sessions.changed", {
				sessionKey,
				phase: lifecyclePhase,
				runId: evt.runId,
				...eventRunId !== evt.runId ? { clientRunId: eventRunId } : {},
				ts: evt.ts,
				...buildSessionEventSnapshot(sessionKey, evt)
			}, sessionEventConnIds, { dropIfSlow: true });
		}
	};
}
//#endregion
export { createAgentEventHandler, createChatRunRegistry, createChatRunState, createSessionEventSubscriberRegistry, createSessionMessageSubscriberRegistry, createToolEventRecipientRegistry };
