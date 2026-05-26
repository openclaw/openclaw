import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import "./agent-scope-CtLXGcWm.js";
import { a as isSubagentSessionKey, c as parseAgentSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { r as logVerbose } from "./globals-YU5FjfZK.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { Ni as ErrorCodes, Pi as errorShape } from "./protocol-DiXjp30g.js";
import { t as getGlobalHookRunner } from "./hook-runner-global-BkXXy1ub.js";
import { a as getActivePluginRegistry } from "./runtime-DHxRl5F1.js";
import { m as triggerInternalHook, n as createInternalHookEvent } from "./internal-hooks-DpfQDjis.js";
import { t as loadCombinedSessionStoreForGateway } from "./combined-store-gateway-NV2GSCR6.js";
import { a as resolveSessionFilePathOptions, i as resolveSessionFilePath } from "./paths-Bg3PO6Gj.js";
import { u as updateSessionStore, v as snapshotSessionOrigin } from "./store-BmtchQvp.js";
import { a as canonicalizeAbsoluteSessionFilePath, o as rewriteSessionFileForNewSessionId } from "./sessions-CQHHcgC_.js";
import { r as runPluginHostCleanup } from "./host-hook-cleanup-4NNJkg8Y.js";
import { t as getAcpSessionManager } from "./manager-CnO_4PJM.js";
import { t as getAcpRuntimeBackend } from "./registry-KuKuvijT.js";
import { i as upsertAcpSessionMeta, n as readAcpSessionEntry } from "./session-meta-CZ8B2a4Z.js";
import { _ as waitForEmbeddedPiRunEnd, n as abortEmbeddedPiRun } from "./runs-DrbsiywK.js";
import { l as readSessionMessagesAsync } from "./session-utils.fs-CsnHXIqH.js";
import { o as resolveStableSessionEndTranscript, r as archiveSessionTranscriptsDetailed } from "./session-transcript-files.fs-CDIpA7EV.js";
import { c as loadSessionEntry, l as migrateAndPruneGatewaySessionStoreKey, m as resolveGatewaySessionStoreTarget, v as resolveSessionModelRef } from "./session-utils-CRKr-5AU.js";
import { n as getSessionBindingService } from "./session-binding-service-B19FMAqz.js";
import { t as clearBootstrapSnapshot } from "./bootstrap-cache-ClkciH8b.js";
import { s as retireSessionMcpRuntime } from "./pi-bundle-mcp-runtime-CwBDIKIq.js";
import "./pi-bundle-mcp-tools-_xKQdIka.js";
import { t as clearAllCliSessions } from "./cli-session-FftCLDUT.js";
import "./pi-embedded-CsSFzly6.js";
import { i as stopSubagentsForRequester } from "./abort-DgYZvSe-.js";
import { a as buildSessionStartHookPayload, i as buildSessionEndHookPayload, n as listActiveSessionsForShutdown, r as noteActiveSessionForShutdown, t as forgetActiveSessionForShutdown } from "./active-sessions-shutdown-tracker-BEPbRoL0.js";
import { n as clearSessionResetRuntimeState, t as resolveResetPreservedSelection } from "./reset-preserved-selection-D8XbdmfQ.js";
import { t as closeTrackedBrowserTabsForSessions } from "./browser-maintenance-CIdUceQj.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
//#region src/gateway/session-child-sessions.ts
function isDirectChildSessionEntry(params) {
	const parentKey = normalizeOptionalString(params.parentKey);
	if (!parentKey || params.sessionKey === parentKey || !params.entry) return false;
	return normalizeOptionalString(params.entry.spawnedBy) === parentKey || normalizeOptionalString(params.entry.parentSessionKey) === parentKey;
}
function findDirectChildSessionsForParent(params) {
	const { store } = loadCombinedSessionStoreForGateway(params.cfg);
	return Object.entries(store).filter(([sessionKey, entry]) => isDirectChildSessionEntry({
		sessionKey,
		entry,
		parentKey: params.parentKey
	})).map(([sessionKey, entry]) => ({
		sessionKey,
		entry
	}));
}
//#endregion
//#region src/gateway/session-reset-service.ts
const ACP_RUNTIME_CLEANUP_TIMEOUT_MS = 15e3;
function resolveResetSessionFile(params) {
	const currentEntry = params.currentEntry;
	const rewrittenSessionFile = currentEntry?.sessionId ? rewriteSessionFileForNewSessionId({
		sessionFile: currentEntry.sessionFile,
		previousSessionId: currentEntry.sessionId,
		nextSessionId: params.nextSessionId
	}) : void 0;
	const preservedSessionFile = (rewrittenSessionFile && path.isAbsolute(rewrittenSessionFile) ? canonicalizeAbsoluteSessionFilePath(rewrittenSessionFile) : rewrittenSessionFile) ?? currentEntry?.sessionFile;
	return resolveSessionFilePath(params.nextSessionId, preservedSessionFile ? { sessionFile: preservedSessionFile } : void 0, resolveSessionFilePathOptions({
		storePath: params.storePath,
		agentId: params.agentId
	}));
}
function stripRuntimeModelState(entry) {
	if (!entry) return entry;
	return {
		...entry,
		model: void 0,
		modelProvider: void 0,
		contextTokens: void 0,
		systemPromptReport: void 0
	};
}
function archiveSessionTranscriptsForSessionDetailed(params) {
	if (!params.sessionId) return [];
	return archiveSessionTranscriptsDetailed({
		sessionId: params.sessionId,
		storePath: params.storePath,
		sessionFile: params.sessionFile,
		agentId: params.agentId,
		reason: params.reason,
		onArchiveError: params.onArchiveError
	});
}
function emitGatewaySessionEndPluginHook(params) {
	if (!params.sessionId) return;
	forgetActiveSessionForShutdown(params.sessionId);
	const hookRunner = getGlobalHookRunner();
	if (!hookRunner?.hasHooks("session_end")) return;
	const transcript = resolveStableSessionEndTranscript({
		sessionId: params.sessionId,
		storePath: params.storePath,
		sessionFile: params.sessionFile,
		agentId: params.agentId,
		archivedTranscripts: params.archivedTranscripts
	});
	const payload = buildSessionEndHookPayload({
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		cfg: params.cfg,
		reason: params.reason,
		sessionFile: transcript.sessionFile,
		transcriptArchived: transcript.transcriptArchived,
		nextSessionId: params.nextSessionId,
		nextSessionKey: params.nextSessionKey
	});
	hookRunner.runSessionEnd(payload.event, payload.context).catch((err) => {
		logVerbose(`session_end hook failed: ${String(err)}`);
	});
}
function emitGatewaySessionStartPluginHook(params) {
	if (!params.sessionId) return;
	if (params.storePath) noteActiveSessionForShutdown({
		cfg: params.cfg,
		sessionKey: params.sessionKey,
		sessionId: params.sessionId,
		storePath: params.storePath,
		sessionFile: params.sessionFile,
		agentId: params.agentId
	});
	const hookRunner = getGlobalHookRunner();
	if (!hookRunner?.hasHooks("session_start")) return;
	const payload = buildSessionStartHookPayload({
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		cfg: params.cfg,
		resumedFrom: params.resumedFrom
	});
	hookRunner.runSessionStart(payload.event, payload.context).catch((err) => {
		logVerbose(`session_start hook failed: ${String(err)}`);
	});
}
const SHUTDOWN_DRAIN_DEFAULT_TOTAL_TIMEOUT_MS = 2e3;
/**
* Emit a typed `session_end` for every session that received `session_start`
* but did not yet receive a paired `session_end`. The bounded total timeout
* mirrors the gateway lifecycle hook timeout so a slow plugin cannot block
* SIGTERM/SIGINT past the runtime's overall shutdown grace window.
*
* Sessions that have already been finalized through replace / reset / delete /
* compaction are forgotten from the tracker by `emitGatewaySessionEndPluginHook`
* before this drain runs, so they will not be double-fired here.
*/
async function drainActiveSessionsForShutdown(params) {
	const tracked = listActiveSessionsForShutdown();
	if (tracked.length === 0) return {
		emittedSessionIds: [],
		timedOut: false
	};
	const totalTimeoutMs = Math.max(100, Math.floor(params.totalTimeoutMs ?? SHUTDOWN_DRAIN_DEFAULT_TOTAL_TIMEOUT_MS));
	const emittedSessionIds = [];
	const hookRunner = getGlobalHookRunner();
	let settledEmissions = 0;
	const drain = Promise.allSettled(tracked.map(async (entry) => {
		try {
			forgetActiveSessionForShutdown(entry.sessionId);
			emittedSessionIds.push(entry.sessionId);
			if (!hookRunner?.hasHooks("session_end")) return;
			const transcript = resolveStableSessionEndTranscript({
				sessionId: entry.sessionId,
				storePath: entry.storePath,
				sessionFile: entry.sessionFile,
				agentId: entry.agentId
			});
			const payload = buildSessionEndHookPayload({
				sessionId: entry.sessionId,
				sessionKey: entry.sessionKey,
				cfg: entry.cfg,
				reason: params.reason,
				sessionFile: transcript.sessionFile,
				transcriptArchived: transcript.transcriptArchived
			});
			await hookRunner.runSessionEnd(payload.event, payload.context);
		} catch (err) {
			logVerbose(`session_end hook failed during shutdown drain: ${String(err)}`);
		} finally {
			settledEmissions++;
		}
	}));
	let timer;
	const timeout = new Promise((resolve) => {
		timer = setTimeout(() => resolve("timeout"), totalTimeoutMs);
		timer.unref?.();
	});
	try {
		if (await Promise.race([drain.then(() => "ok"), timeout]) === "timeout") {
			logVerbose(`shutdown session-end drain timed out after ${totalTimeoutMs}ms with ${tracked.length - settledEmissions} session_end handler(s) still pending`);
			return {
				emittedSessionIds,
				timedOut: true
			};
		}
		return {
			emittedSessionIds,
			timedOut: false
		};
	} finally {
		if (timer) clearTimeout(timer);
	}
}
async function emitSessionUnboundLifecycleEvent(params) {
	const targetKind = isSubagentSessionKey(params.targetSessionKey) ? "subagent" : "acp";
	await getSessionBindingService().unbind({
		targetSessionKey: params.targetSessionKey,
		reason: params.reason
	});
	if (params.emitHooks === false) return;
	const hookRunner = getGlobalHookRunner();
	if (!hookRunner?.hasHooks("subagent_ended")) return;
	await hookRunner.runSubagentEnded({
		targetSessionKey: params.targetSessionKey,
		targetKind,
		reason: params.reason,
		sendFarewell: true,
		outcome: params.reason === "session-reset" ? "reset" : "deleted"
	}, { childSessionKey: params.targetSessionKey });
}
async function ensureSessionRuntimeCleanup(params) {
	const closeTrackedBrowserTabs = async () => {
		return await closeTrackedBrowserTabsForSessions({
			sessionKeys: [...new Set([
				params.key,
				params.target.canonicalKey,
				...params.target.storeKeys,
				params.sessionId ?? ""
			])],
			onWarn: (message) => logVerbose(message)
		});
	};
	const queueKeys = new Set(params.target.storeKeys);
	queueKeys.add(params.target.canonicalKey);
	if (params.sessionId) queueKeys.add(params.sessionId);
	clearSessionResetRuntimeState([...queueKeys]);
	stopSubagentsForRequester({
		cfg: params.cfg,
		requesterSessionKey: params.target.canonicalKey
	});
	if (!params.sessionId) {
		clearBootstrapSnapshot(params.target.canonicalKey);
		await closeTrackedBrowserTabs();
		return;
	}
	abortEmbeddedPiRun(params.sessionId);
	const ended = await waitForEmbeddedPiRunEnd(params.sessionId, 15e3);
	clearBootstrapSnapshot(params.target.canonicalKey);
	if (ended) {
		await retireSessionMcpRuntime({
			sessionId: params.sessionId,
			reason: "gateway-session-cleanup",
			onError: (error, sessionId) => {
				logVerbose(`sessions cleanup: failed to dispose bundle MCP runtime for ${sessionId}: ${String(error)}`);
			}
		});
		await closeTrackedBrowserTabs();
		return;
	}
	return errorShape(ErrorCodes.UNAVAILABLE, `Session ${params.key} is still active; try again in a moment.`);
}
async function runAcpCleanupStep(params) {
	let timer;
	const timeoutPromise = new Promise((resolve) => {
		timer = setTimeout(() => resolve({ status: "timeout" }), ACP_RUNTIME_CLEANUP_TIMEOUT_MS);
	});
	const opPromise = params.op().then(() => ({ status: "ok" })).catch((error) => ({
		status: "error",
		error
	}));
	const outcome = await Promise.race([opPromise, timeoutPromise]);
	if (timer) clearTimeout(timer);
	return outcome;
}
async function closeAcpRuntimeForSession(params) {
	if (!params.entry?.acp) return;
	const acpManager = getAcpSessionManager();
	const cancelOutcome = await runAcpCleanupStep({ op: async () => {
		await acpManager.cancelSession({
			cfg: params.cfg,
			sessionKey: params.sessionKey,
			reason: params.reason
		});
	} });
	if (cancelOutcome.status === "timeout") return errorShape(ErrorCodes.UNAVAILABLE, `Session ${params.sessionKey} is still active; try again in a moment.`);
	if (cancelOutcome.status === "error") logVerbose(`sessions.${params.reason}: ACP cancel failed for ${params.sessionKey}: ${String(cancelOutcome.error)}`);
	const closeOutcome = await runAcpCleanupStep({ op: async () => {
		await acpManager.closeSession({
			cfg: params.cfg,
			sessionKey: params.sessionKey,
			reason: params.reason,
			discardPersistentState: true,
			requireAcpSession: false,
			allowBackendUnavailable: true
		});
	} });
	if (closeOutcome.status === "timeout") return errorShape(ErrorCodes.UNAVAILABLE, `Session ${params.sessionKey} is still active; try again in a moment.`);
	if (closeOutcome.status === "error") logVerbose(`sessions.${params.reason}: ACP runtime close failed for ${params.sessionKey}: ${String(closeOutcome.error)}`);
	await ensureFreshAcpResetState({
		cfg: params.cfg,
		sessionKey: params.sessionKey,
		reason: params.reason,
		entry: params.entry
	});
}
function buildPendingAcpMeta(base, now) {
	const currentIdentity = base.identity;
	const nextIdentity = currentIdentity ? {
		state: "pending",
		...currentIdentity.acpxRecordId ? { acpxRecordId: currentIdentity.acpxRecordId } : {},
		source: currentIdentity.source,
		lastUpdatedAt: now
	} : void 0;
	return {
		backend: base.backend,
		agent: base.agent,
		runtimeSessionName: base.runtimeSessionName,
		...nextIdentity ? { identity: nextIdentity } : {},
		mode: base.mode,
		...base.runtimeOptions ? { runtimeOptions: base.runtimeOptions } : {},
		...base.cwd ? { cwd: base.cwd } : {},
		state: "idle",
		lastActivityAt: now
	};
}
async function ensureFreshAcpResetState(params) {
	if (params.reason !== "session-reset" || !params.entry?.acp) return;
	const latestMeta = readAcpSessionEntry({
		cfg: params.cfg,
		sessionKey: params.sessionKey
	})?.acp;
	if (!latestMeta?.identity || latestMeta.identity.state !== "resolved" || !latestMeta.identity.acpxSessionId && !latestMeta.identity.agentSessionId) return;
	const backendId = (latestMeta.backend || params.cfg.acp?.backend || "").trim() || void 0;
	try {
		await getAcpRuntimeBackend(backendId)?.runtime.prepareFreshSession?.({ sessionKey: params.sessionKey });
	} catch (error) {
		logVerbose(`sessions.${params.reason}: ACP prepareFreshSession failed for ${params.sessionKey}: ${String(error)}`);
	}
	const now = Date.now();
	await upsertAcpSessionMeta({
		cfg: params.cfg,
		sessionKey: params.sessionKey,
		mutate: (current, entry) => {
			const base = current ?? entry?.acp;
			if (!base) return null;
			return buildPendingAcpMeta(base, now);
		}
	});
}
async function closeChildAcpRuntimesForParent(params) {
	let children;
	try {
		children = findDirectChildSessionsForParent({
			cfg: params.cfg,
			parentKey: params.parentKey
		}).filter(({ entry }) => entry.acp);
	} catch (error) {
		logVerbose(`sessions.${params.reason}: failed to enumerate sessions for child ACP cleanup: ${String(error)}`);
		return;
	}
	await Promise.allSettled(children.map(({ sessionKey, entry }) => closeAcpRuntimeForSession({
		cfg: params.cfg,
		sessionKey,
		entry,
		reason: params.reason
	}).then((childError) => {
		if (childError) logVerbose(`sessions.${params.reason}: child ACP cleanup incomplete for ${sessionKey}`);
	})));
}
async function cleanupSessionBeforeMutation(params) {
	const cleanupError = await ensureSessionRuntimeCleanup({
		cfg: params.cfg,
		key: params.key,
		target: params.target,
		sessionId: params.entry?.sessionId
	});
	if (cleanupError) return cleanupError;
	const pluginCleanup = await runPluginHostCleanup({
		cfg: params.cfg,
		registry: getActivePluginRegistry(),
		reason: params.reason === "session-reset" ? "reset" : "delete",
		sessionKey: params.target.canonicalKey ?? params.key
	});
	for (const failure of pluginCleanup.failures) logVerbose(`plugin host cleanup failed for ${failure.pluginId}/${failure.hookId}: ${String(failure.error)}`);
	const parentAcpError = await closeAcpRuntimeForSession({
		cfg: params.cfg,
		sessionKey: params.legacyKey ?? params.canonicalKey ?? params.target.canonicalKey ?? params.key,
		entry: params.entry,
		reason: params.reason
	});
	await closeChildAcpRuntimesForParent({
		cfg: params.cfg,
		parentKey: params.target.canonicalKey ?? params.canonicalKey ?? params.key,
		reason: params.reason
	});
	return parentAcpError;
}
async function emitGatewayBeforeResetPluginHook(params) {
	const hookRunner = getGlobalHookRunner();
	if (!hookRunner?.hasHooks("before_reset")) return;
	const sessionKey = params.target.canonicalKey ?? params.key;
	const sessionId = params.entry?.sessionId;
	const sessionFile = params.entry?.sessionFile;
	const agentId = normalizeAgentId(params.target.agentId ?? resolveDefaultAgentId(params.cfg));
	const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
	let messages = [];
	try {
		if (typeof sessionId === "string" && sessionId.trim().length > 0) messages = await readSessionMessagesAsync(sessionId, params.storePath, sessionFile, {
			mode: "full",
			reason: "before_reset hook payload"
		});
	} catch (err) {
		logVerbose(`before_reset: failed to read session messages for ${sessionId ?? "(none)"}; firing hook with empty messages (${String(err)})`);
	}
	hookRunner.runBeforeReset({
		sessionFile,
		messages,
		reason: params.reason
	}, {
		agentId,
		sessionKey,
		sessionId,
		workspaceDir
	}).catch((err) => {
		logVerbose(`before_reset hook failed: ${String(err)}`);
	});
}
async function performGatewaySessionReset(params) {
	const { cfg, target, storePath } = (() => {
		const cfg = getRuntimeConfig();
		const target = resolveGatewaySessionStoreTarget({
			cfg,
			key: params.key
		});
		return {
			cfg,
			target,
			storePath: target.storePath
		};
	})();
	const { entry, legacyKey, canonicalKey } = loadSessionEntry(params.key);
	const hadExistingEntry = Boolean(entry);
	const workspaceDir = resolveAgentWorkspaceDir(cfg, normalizeAgentId(target.agentId ?? resolveDefaultAgentId(cfg)));
	await triggerInternalHook(createInternalHookEvent("command", params.reason, target.canonicalKey ?? params.key, {
		sessionEntry: entry,
		previousSessionEntry: entry,
		commandSource: params.commandSource,
		cfg,
		workspaceDir
	}));
	const mutationCleanupError = await cleanupSessionBeforeMutation({
		cfg,
		key: params.key,
		target,
		entry,
		legacyKey,
		canonicalKey,
		reason: "session-reset"
	});
	if (mutationCleanupError) return {
		ok: false,
		error: mutationCleanupError
	};
	let oldSessionId;
	let oldSessionFile;
	let resetSourceEntry;
	const next = await updateSessionStore(storePath, (store) => {
		const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({
			cfg,
			key: params.key,
			store
		});
		const currentEntry = store[primaryKey];
		resetSourceEntry = currentEntry ? { ...currentEntry } : void 0;
		const sessionAgentId = normalizeAgentId(parseAgentSessionKey(primaryKey)?.agentId ?? resolveDefaultAgentId(cfg));
		const resetPreservedSelection = resolveResetPreservedSelection({ entry: currentEntry });
		const resetEntry = {
			...stripRuntimeModelState(currentEntry),
			providerOverride: void 0,
			modelOverride: void 0,
			modelOverrideSource: void 0,
			authProfileOverride: void 0,
			authProfileOverrideSource: void 0,
			authProfileOverrideCompactionCount: void 0,
			...resetPreservedSelection
		};
		const resolvedModel = resolveSessionModelRef(cfg, resetEntry, sessionAgentId);
		oldSessionId = currentEntry?.sessionId;
		oldSessionFile = currentEntry?.sessionFile;
		const now = Date.now();
		const nextSessionId = randomUUID();
		const nextEntry = {
			sessionId: nextSessionId,
			sessionFile: resolveResetSessionFile({
				nextSessionId,
				currentEntry,
				storePath,
				agentId: sessionAgentId
			}),
			updatedAt: now,
			systemSent: false,
			abortedLastRun: false,
			thinkingLevel: currentEntry?.thinkingLevel,
			fastMode: currentEntry?.fastMode,
			verboseLevel: currentEntry?.verboseLevel,
			traceLevel: currentEntry?.traceLevel,
			reasoningLevel: currentEntry?.reasoningLevel,
			elevatedLevel: currentEntry?.elevatedLevel,
			ttsAuto: currentEntry?.ttsAuto,
			execHost: currentEntry?.execHost,
			execSecurity: currentEntry?.execSecurity,
			execAsk: currentEntry?.execAsk,
			execNode: currentEntry?.execNode,
			responseUsage: currentEntry?.responseUsage,
			...resetPreservedSelection,
			groupActivation: currentEntry?.groupActivation,
			groupActivationNeedsSystemIntro: currentEntry?.groupActivationNeedsSystemIntro,
			chatType: currentEntry?.chatType,
			model: resolvedModel.model,
			modelProvider: resolvedModel.provider,
			contextTokens: resetEntry?.contextTokens,
			compactionCount: currentEntry?.compactionCount,
			compactionCheckpoints: currentEntry?.compactionCheckpoints,
			sendPolicy: currentEntry?.sendPolicy,
			queueMode: currentEntry?.queueMode,
			queueDebounceMs: currentEntry?.queueDebounceMs,
			queueCap: currentEntry?.queueCap,
			queueDrop: currentEntry?.queueDrop,
			spawnedBy: currentEntry?.spawnedBy,
			spawnedWorkspaceDir: currentEntry?.spawnedWorkspaceDir,
			parentSessionKey: currentEntry?.parentSessionKey,
			forkedFromParent: currentEntry?.forkedFromParent,
			spawnDepth: currentEntry?.spawnDepth,
			subagentRole: currentEntry?.subagentRole,
			subagentControlScope: currentEntry?.subagentControlScope,
			label: currentEntry?.label,
			displayName: currentEntry?.displayName,
			channel: currentEntry?.channel,
			groupId: currentEntry?.groupId,
			subject: currentEntry?.subject,
			groupChannel: currentEntry?.groupChannel,
			space: currentEntry?.space,
			origin: snapshotSessionOrigin(currentEntry),
			deliveryContext: currentEntry?.deliveryContext,
			cliSessionBindings: currentEntry?.cliSessionBindings,
			cliSessionIds: currentEntry?.cliSessionIds,
			claudeCliSessionId: currentEntry?.claudeCliSessionId,
			lastChannel: currentEntry?.lastChannel,
			lastTo: currentEntry?.lastTo,
			lastAccountId: currentEntry?.lastAccountId,
			lastThreadId: currentEntry?.lastThreadId,
			acp: currentEntry?.acp,
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			totalTokensFresh: true
		};
		if (!isSubagentSessionKey(primaryKey)) clearAllCliSessions(nextEntry);
		store[primaryKey] = nextEntry;
		return nextEntry;
	});
	await emitGatewayBeforeResetPluginHook({
		cfg,
		key: params.key,
		target,
		storePath,
		entry: resetSourceEntry,
		reason: params.reason
	});
	const archivedTranscripts = archiveSessionTranscriptsForSessionDetailed({
		sessionId: oldSessionId,
		storePath,
		sessionFile: oldSessionFile,
		agentId: target.agentId,
		reason: "reset"
	});
	fs.mkdirSync(path.dirname(next.sessionFile), { recursive: true });
	if (!fs.existsSync(next.sessionFile)) {
		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: next.sessionId,
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			cwd: process.cwd()
		};
		fs.writeFileSync(next.sessionFile, `${JSON.stringify(header)}\n`, {
			encoding: "utf-8",
			mode: 384
		});
	}
	emitGatewaySessionEndPluginHook({
		cfg,
		sessionKey: target.canonicalKey ?? params.key,
		sessionId: oldSessionId,
		storePath,
		sessionFile: oldSessionFile,
		agentId: target.agentId,
		reason: params.reason,
		archivedTranscripts,
		nextSessionId: next.sessionId
	});
	emitGatewaySessionStartPluginHook({
		cfg,
		sessionKey: target.canonicalKey ?? params.key,
		sessionId: next.sessionId,
		resumedFrom: oldSessionId,
		storePath,
		sessionFile: next.sessionFile,
		agentId: target.agentId
	});
	if (hadExistingEntry) await emitSessionUnboundLifecycleEvent({
		targetSessionKey: target.canonicalKey ?? params.key,
		reason: "session-reset"
	});
	return {
		ok: true,
		key: target.canonicalKey,
		entry: next
	};
}
//#endregion
export { emitGatewaySessionEndPluginHook as a, performGatewaySessionReset as c, emitGatewayBeforeResetPluginHook as i, cleanupSessionBeforeMutation as n, emitGatewaySessionStartPluginHook as o, drainActiveSessionsForShutdown as r, emitSessionUnboundLifecycleEvent as s, archiveSessionTranscriptsForSessionDetailed as t };
