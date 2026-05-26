import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { t as loadCombinedSessionStoreForGateway } from "./combined-store-gateway-NV2GSCR6.js";
import { n as asPositiveSafeInteger } from "./number-coercion-CgoBR0cm.js";
import { c as readSessionMessageCountAsync, t as attachOpenClawTranscriptMeta } from "./session-utils.fs-CsnHXIqH.js";
import { a as resolveSessionTranscriptCandidates } from "./session-transcript-files.fs-CDIpA7EV.js";
import { c as loadSessionEntry, m as resolveGatewaySessionStoreTarget, s as loadGatewaySessionRow } from "./session-utils-CRKr-5AU.js";
import { t as resolvePreferredSessionKeyForSessionIdMatches } from "./session-id-resolution-CQPMwA0q.js";
import { r as projectChatDisplayMessage } from "./chat-display-projection-D_n0QMN-.js";
import fs from "node:fs";
import path from "node:path";
//#region src/gateway/session-transcript-key.ts
const TRANSCRIPT_SESSION_KEY_CACHE = /* @__PURE__ */ new Map();
const TRANSCRIPT_SESSION_KEY_CACHE_MAX = 256;
function resolveTranscriptPathForComparison(value) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) return;
	const resolved = path.resolve(trimmed);
	try {
		return fs.realpathSync(resolved);
	} catch {
		return resolved;
	}
}
function sessionKeyMatchesTranscriptPath(params) {
	const entry = params.store[params.key];
	if (!entry?.sessionId) return false;
	const target = resolveGatewaySessionStoreTarget({
		cfg: params.cfg,
		key: params.key,
		scanLegacyKeys: false,
		store: params.store
	});
	const sessionAgentId = normalizeAgentId(target.agentId);
	return resolveSessionTranscriptCandidates(entry.sessionId, target.storePath, entry.sessionFile, sessionAgentId).some((candidate) => resolveTranscriptPathForComparison(candidate) === params.targetPath);
}
function resolveSessionKeyForTranscriptFile(sessionFile) {
	const targetPath = resolveTranscriptPathForComparison(sessionFile);
	if (!targetPath) return;
	const cfg = getRuntimeConfig();
	const { store } = loadCombinedSessionStoreForGateway(cfg);
	const cachedKey = TRANSCRIPT_SESSION_KEY_CACHE.get(targetPath);
	if (cachedKey && sessionKeyMatchesTranscriptPath({
		cfg,
		store,
		key: cachedKey,
		targetPath
	})) return cachedKey;
	const matchingEntries = [];
	for (const [key, entry] of Object.entries(store)) {
		if (!entry?.sessionId || key === cachedKey) continue;
		if (sessionKeyMatchesTranscriptPath({
			cfg,
			store,
			key,
			targetPath
		})) matchingEntries.push([key, entry]);
	}
	if (matchingEntries.length > 0) {
		const matchesBySessionId = /* @__PURE__ */ new Map();
		for (const entry of matchingEntries) {
			const sessionId = entry[1].sessionId;
			if (!sessionId) continue;
			const group = matchesBySessionId.get(sessionId);
			if (group) group.push(entry);
			else matchesBySessionId.set(sessionId, [entry]);
		}
		const resolvedMatches = Array.from(matchesBySessionId.entries()).map(([sessionId, matches]) => {
			const resolvedKey = resolvePreferredSessionKeyForSessionIdMatches(matches, sessionId) ?? matches[0]?.[0];
			const resolvedEntry = resolvedKey ? matches.find(([key]) => key === resolvedKey)?.[1] : void 0;
			return resolvedKey && resolvedEntry ? {
				key: resolvedKey,
				updatedAt: resolvedEntry.updatedAt ?? 0
			} : void 0;
		}).filter((match) => match !== void 0);
		const [freshestMatch, secondFreshestMatch] = [...resolvedMatches].toSorted((a, b) => b.updatedAt - a.updatedAt);
		const resolvedKey = resolvedMatches.length === 1 ? freshestMatch?.key : (freshestMatch?.updatedAt ?? 0) > (secondFreshestMatch?.updatedAt ?? 0) ? freshestMatch?.key : void 0;
		if (resolvedKey) {
			if (!TRANSCRIPT_SESSION_KEY_CACHE.has(targetPath) && TRANSCRIPT_SESSION_KEY_CACHE.size >= TRANSCRIPT_SESSION_KEY_CACHE_MAX) {
				const oldest = TRANSCRIPT_SESSION_KEY_CACHE.keys().next().value;
				if (oldest !== void 0) TRANSCRIPT_SESSION_KEY_CACHE.delete(oldest);
			}
			TRANSCRIPT_SESSION_KEY_CACHE.set(targetPath, resolvedKey);
			return resolvedKey;
		}
	}
	TRANSCRIPT_SESSION_KEY_CACHE.delete(targetPath);
}
//#endregion
//#region src/gateway/server-session-events.ts
function buildGatewaySessionSnapshot(params) {
	const { sessionRow } = params;
	if (!sessionRow) return {};
	return {
		...params.includeSession ? { session: sessionRow } : {},
		updatedAt: sessionRow.updatedAt ?? void 0,
		sessionId: sessionRow.sessionId,
		kind: sessionRow.kind,
		channel: sessionRow.channel,
		subject: sessionRow.subject,
		groupChannel: sessionRow.groupChannel,
		space: sessionRow.space,
		chatType: sessionRow.chatType,
		origin: sessionRow.origin,
		spawnedBy: sessionRow.spawnedBy,
		spawnedWorkspaceDir: sessionRow.spawnedWorkspaceDir,
		forkedFromParent: sessionRow.forkedFromParent,
		spawnDepth: sessionRow.spawnDepth,
		subagentRole: sessionRow.subagentRole,
		subagentControlScope: sessionRow.subagentControlScope,
		label: params.label ?? sessionRow.label,
		displayName: params.displayName ?? sessionRow.displayName,
		deliveryContext: sessionRow.deliveryContext,
		parentSessionKey: params.parentSessionKey ?? sessionRow.parentSessionKey,
		childSessions: sessionRow.childSessions,
		thinkingLevel: sessionRow.thinkingLevel,
		fastMode: sessionRow.fastMode,
		verboseLevel: sessionRow.verboseLevel,
		reasoningLevel: sessionRow.reasoningLevel,
		elevatedLevel: sessionRow.elevatedLevel,
		sendPolicy: sessionRow.sendPolicy,
		systemSent: sessionRow.systemSent,
		abortedLastRun: sessionRow.abortedLastRun,
		inputTokens: sessionRow.inputTokens,
		outputTokens: sessionRow.outputTokens,
		lastChannel: sessionRow.lastChannel,
		lastTo: sessionRow.lastTo,
		lastAccountId: sessionRow.lastAccountId,
		lastThreadId: sessionRow.lastThreadId,
		totalTokens: sessionRow.totalTokens,
		totalTokensFresh: sessionRow.totalTokensFresh,
		contextTokens: sessionRow.contextTokens,
		estimatedCostUsd: sessionRow.estimatedCostUsd,
		responseUsage: sessionRow.responseUsage,
		modelProvider: sessionRow.modelProvider,
		model: sessionRow.model,
		status: sessionRow.status,
		subagentRunState: sessionRow.subagentRunState,
		hasActiveSubagentRun: sessionRow.hasActiveSubagentRun,
		startedAt: sessionRow.startedAt,
		endedAt: sessionRow.endedAt,
		runtimeMs: sessionRow.runtimeMs,
		compactionCheckpointCount: sessionRow.compactionCheckpointCount,
		latestCompactionCheckpoint: sessionRow.latestCompactionCheckpoint
	};
}
function createTranscriptUpdateBroadcastHandler(params) {
	let broadcastQueue = Promise.resolve();
	return (update) => {
		broadcastQueue = broadcastQueue.then(() => handleTranscriptUpdateBroadcast(params, update)).catch(() => void 0);
	};
}
async function handleTranscriptUpdateBroadcast(params, update) {
	const sessionKey = update.sessionKey ?? resolveSessionKeyForTranscriptFile(update.sessionFile);
	if (!sessionKey || update.message === void 0) return;
	const connIds = /* @__PURE__ */ new Set();
	for (const connId of params.sessionEventSubscribers.getAll()) connIds.add(connId);
	for (const connId of params.sessionMessageSubscribers.get(sessionKey)) connIds.add(connId);
	if (connIds.size === 0) return;
	let messageSeq = asPositiveSafeInteger(update.messageSeq);
	if (messageSeq === void 0) {
		const { entry, storePath } = loadSessionEntry(sessionKey);
		messageSeq = entry?.sessionId ? asPositiveSafeInteger(await readSessionMessageCountAsync(entry.sessionId, storePath, entry.sessionFile)) : void 0;
	}
	const sessionSnapshot = buildGatewaySessionSnapshot({
		sessionRow: loadGatewaySessionRow(sessionKey, { transcriptUsageMaxBytes: 64 * 1024 }),
		includeSession: true
	});
	const message = projectChatDisplayMessage(attachOpenClawTranscriptMeta(update.message, {
		...typeof update.messageId === "string" ? { id: update.messageId } : {},
		...messageSeq !== void 0 ? { seq: messageSeq } : {}
	}));
	if (message) params.broadcastToConnIds("session.message", {
		sessionKey,
		message,
		...typeof update.messageId === "string" ? { messageId: update.messageId } : {},
		...messageSeq !== void 0 ? { messageSeq } : {},
		...sessionSnapshot
	}, connIds, { dropIfSlow: true });
	const sessionEventConnIds = params.sessionEventSubscribers.getAll();
	if (sessionEventConnIds.size === 0) return;
	params.broadcastToConnIds("sessions.changed", {
		sessionKey,
		phase: "message",
		ts: Date.now(),
		...typeof update.messageId === "string" ? { messageId: update.messageId } : {},
		...messageSeq !== void 0 ? { messageSeq } : {},
		...sessionSnapshot
	}, sessionEventConnIds, { dropIfSlow: true });
}
function createLifecycleEventBroadcastHandler(params) {
	return (event) => {
		const connIds = params.sessionEventSubscribers.getAll();
		if (connIds.size === 0) return;
		params.broadcastToConnIds("sessions.changed", {
			sessionKey: event.sessionKey,
			reason: event.reason,
			parentSessionKey: event.parentSessionKey,
			label: event.label,
			displayName: event.displayName,
			ts: Date.now(),
			...buildGatewaySessionSnapshot({
				sessionRow: loadGatewaySessionRow(event.sessionKey),
				label: event.label,
				displayName: event.displayName,
				parentSessionKey: event.parentSessionKey
			})
		}, connIds, { dropIfSlow: true });
	};
}
//#endregion
export { createLifecycleEventBroadcastHandler, createTranscriptUpdateBroadcastHandler };
