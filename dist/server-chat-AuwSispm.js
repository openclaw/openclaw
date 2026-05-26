import { n as detectErrorKind } from "./errors-VfATXfah.js";
import { a as isSubagentSessionKey, n as isAcpSessionKey } from "./session-key-utils-qD-NZHCY.js";
import { i as getRuntimeConfig } from "./io-5xE1dPMK.js";
import { g as normalizeVerboseLevel } from "./thinking-ix_990qw.js";
import { r as setSafeTimeout } from "./timer-delay-DRWiqOjC.js";
import { c as getAgentRunContext } from "./agent-events-CXxjiM_O.js";
import { c as updateSessionStoreEntry } from "./store-3qAZ3Zl6.js";
import "./sessions-BhOk6siH.js";
import { u as stripHeartbeatToken } from "./heartbeat-DJ4ZZ8Yg.js";
import { a as resolveToolSearchCodeDisplayTarget } from "./tool-display-common-BeRUNOwy.js";
import { c as loadSessionEntry, s as loadGatewaySessionRow } from "./session-utils-BcTdpiLf.js";
import { t as resolveHeartbeatVisibility } from "./heartbeat-visibility-C2THeR71.js";
import { t as formatForLog } from "./ws-log-CjqaGuge.js";
import { i as shouldSuppressAssistantEventForLiveChat, n as projectLiveAssistantBufferedText, r as resolveMergedAssistantText, t as normalizeLiveAssistantEventText } from "./live-chat-projector-CApsR-Ik.js";
import { a as createToolEventRecipientRegistry, i as createSessionMessageSubscriberRegistry, n as createChatRunState, r as createSessionEventSubscriberRegistry, t as createChatRunRegistry } from "./server-chat-state-D_t6NNo9.js";
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
	const clearBufferedChatState = (clientRunId) => {
		chatRunState.rawBuffers.delete(clientRunId);
		chatRunState.buffers.delete(clientRunId);
		chatRunState.deltaSentAt.delete(clientRunId);
		chatRunState.deltaLastBroadcastLen.delete(clientRunId);
		chatRunState.deltaLastBroadcastText.delete(clientRunId);
	};
	const clearPendingTerminalLifecycleError = (runId) => {
		const pending = pendingTerminalLifecycleErrors.get(runId);
		if (!pending) return;
		clearTimeout(pending);
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
				ts: evt.ts,
				...buildSessionEventSnapshot(sessionKey, evt)
			}, sessionEventConnIds, { dropIfSlow: true });
		}
	};
	const scheduleTerminalLifecycleError = (evt, opts) => {
		clearPendingTerminalLifecycleError(evt.runId);
		const timer = setSafeTimeout(() => {
			pendingTerminalLifecycleErrors.delete(evt.runId);
			finalizeLifecycleEvent(evt, opts);
		}, lifecycleErrorRetryGraceMs);
		timer.unref?.();
		pendingTerminalLifecycleErrors.set(evt.runId, timer);
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
		if (evt.stream !== "lifecycle" || lifecyclePhase !== "error") clearPendingTerminalLifecycleError(evt.runId);
		const chatLink = chatRunState.registry.peek(evt.runId);
		const eventSessionKey = typeof evt.sessionKey === "string" && evt.sessionKey.trim() ? evt.sessionKey : void 0;
		const isControlUiVisible = getAgentRunContext(evt.runId)?.isControlUiVisible ?? true;
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
			...spawnedBy && { spawnedBy }
		} : eventForClients;
		const last = agentRunSeq.get(evt.runId) ?? 0;
		const isToolEvent = evt.stream === "tool";
		const isItemEvent = evt.stream === "item";
		const toolVerbose = isToolEvent ? resolveToolVerboseLevel(evt.runId, sessionKey) : "off";
		const channelToolPayload = isToolEvent && toolVerbose !== "full" ? (() => {
			const data = evt.data ? { ...evt.data } : {};
			delete data.result;
			delete data.partialResult;
			return sessionKey ? {
				...eventForClients,
				sessionKey,
				data
			} : {
				...eventForClients,
				data
			};
		})() : agentPayload;
		if (last > 0 && evt.seq !== last + 1 && isControlUiVisible) broadcast("agent", {
			runId: eventRunId,
			stream: "error",
			ts: Date.now(),
			sessionKey,
			...spawnedBy && { spawnedBy },
			data: {
				reason: "seq gap",
				expected: last + 1,
				received: evt.seq
			}
		});
		agentRunSeq.set(evt.runId, evt.seq);
		if (isToolEvent) {
			if ((typeof evt.data?.phase === "string" ? evt.data.phase : "") === "start" && isControlUiVisible && sessionKey && !isAborted) flushBufferedChatDeltaIfNeeded(sessionKey, clientRunId, evt.runId, evt.seq);
			const recipients = toolEventRecipients.get(evt.runId);
			if (isControlUiVisible && recipients && recipients.size > 0) broadcastToConnIds("agent", sessionKey ? {
				...agentPayload,
				...buildSessionEventSnapshot(sessionKey)
			} : agentPayload, recipients);
			if (isControlUiVisible && sessionKey) {
				const sessionSubscribers = sessionEventSubscribers.getAll();
				if (sessionSubscribers.size > 0) broadcastToConnIds("session.tool", {
					...agentPayload,
					...buildSessionEventSnapshot(sessionKey)
				}, sessionSubscribers, { dropIfSlow: true });
			}
		} else {
			if ((isItemEvent && typeof evt.data?.phase === "string" ? evt.data.phase : "") === "start" && isControlUiVisible && sessionKey && !isAborted) flushBufferedChatDeltaIfNeeded(sessionKey, clientRunId, evt.runId, evt.seq);
			if (isControlUiVisible) broadcast("agent", agentPayload);
		}
		if (isControlUiVisible && sessionKey) {
			if (!isToolEvent || toolVerbose !== "off") nodeSendToSession(sessionKey, "agent", isToolEvent ? projectToolSearchCodeEventForChannelPayload({
				...channelToolPayload,
				...buildSessionEventSnapshot(sessionKey)
			}) : agentPayload);
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
				ts: evt.ts,
				...buildSessionEventSnapshot(sessionKey, evt)
			}, sessionEventConnIds, { dropIfSlow: true });
		}
	};
}
//#endregion
export { createAgentEventHandler, createChatRunRegistry, createChatRunState, createSessionEventSubscriberRegistry, createSessionMessageSubscriberRegistry, createToolEventRecipientRegistry };
