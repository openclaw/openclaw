import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { u as resolveAgentIdFromSessionKey } from "./session-key-CuQ3FxQd.js";
import { t as matchesSkillFilter } from "./filter-C6LM1yyQ.js";
import { p as resolveSessionAgentId } from "./agent-scope-CcthxFej.js";
import { r as logVerbose } from "./globals-f3TwV797.js";
import { t as getGlobalHookRunner } from "./hook-runner-global-BbkdpoaV.js";
import { a as resolveSessionFilePathOptions, i as resolveSessionFilePath } from "./paths-BYkpLqJF.js";
import { n as mergeSessionEntry } from "./types-ePnHAw38.js";
import { d as normalizeStoreSessionKey, f as resolveSessionStoreEntry, s as updateSessionStore } from "./store-bHMyvLAj.js";
import "./sessions-BPwe-yj6.js";
import { o as resolveStableSessionEndTranscript } from "./session-transcript-files.fs-BjPaDXQR.js";
import { t as buildWorkspaceSkillSnapshot } from "./workspace-BnFf0hHd.js";
import "./skills-CVBVKpsU.js";
import { t as canExecRequestNode } from "./exec-defaults-D-QPtPae.js";
import { n as getSkillsSnapshotVersion, o as shouldRefreshSnapshotForVersion } from "./refresh-state-D8fQn08t.js";
import { n as ensureSkillsWatcher } from "./refresh-CINPrZb0.js";
import { t as hydrateResolvedSkills } from "./snapshot-hydration-C9Y8mtNO.js";
import { t as getRemoteSkillEligibility } from "./skills-remote-o9b9gEnR.js";
import { n as buildSessionStartHookPayload, t as buildSessionEndHookPayload } from "./session-hooks-BHW4kNOl.js";
import "./session-system-events-gLp6n8XM.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
//#region src/auto-reply/reply/session-updates.ts
async function persistSessionEntryUpdate(params) {
	if (!params.sessionStore || !params.sessionKey) return;
	const sessionKey = params.sessionKey;
	{
		const memResolved = resolveSessionStoreEntry({
			store: params.sessionStore,
			sessionKey
		});
		params.sessionStore[memResolved.normalizedKey] = {
			...memResolved.existing,
			...params.nextEntry
		};
		for (const legacyKey of memResolved.legacyKeys) delete params.sessionStore[legacyKey];
	}
	if (!params.storePath) return;
	await updateSessionStore(params.storePath, (store) => {
		const resolved = resolveSessionStoreEntry({
			store,
			sessionKey: params.sessionKey
		});
		store[resolved.normalizedKey] = {
			...resolved.existing,
			...params.nextEntry
		};
		for (const legacyKey of resolved.legacyKeys) delete store[legacyKey];
	});
}
function emitCompactionSessionLifecycleHooks(params) {
	const hookRunner = getGlobalHookRunner();
	if (!hookRunner) return;
	if (hookRunner.hasHooks("session_end")) {
		const transcript = resolveStableSessionEndTranscript({
			sessionId: params.previousEntry.sessionId,
			storePath: params.storePath,
			sessionFile: params.previousEntry.sessionFile,
			agentId: resolveAgentIdFromSessionKey(params.sessionKey)
		});
		const payload = buildSessionEndHookPayload({
			sessionId: params.previousEntry.sessionId,
			sessionKey: params.sessionKey,
			cfg: params.cfg,
			reason: "compaction",
			sessionFile: transcript.sessionFile,
			transcriptArchived: transcript.transcriptArchived,
			nextSessionId: params.nextEntry.sessionId
		});
		hookRunner.runSessionEnd(payload.event, payload.context).catch((err) => {
			logVerbose(`session_end hook failed: ${String(err)}`);
		});
	}
	if (hookRunner.hasHooks("session_start")) {
		const payload = buildSessionStartHookPayload({
			sessionId: params.nextEntry.sessionId,
			sessionKey: params.sessionKey,
			cfg: params.cfg,
			resumedFrom: params.previousEntry.sessionId
		});
		hookRunner.runSessionStart(payload.event, payload.context).catch((err) => {
			logVerbose(`session_start hook failed: ${String(err)}`);
		});
	}
}
function resolvePositiveTokenCount(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : void 0;
}
async function ensureSkillSnapshot(params) {
	if (process.env.OPENCLAW_TEST_FAST === "1") return {
		sessionEntry: params.sessionEntry,
		skillsSnapshot: params.sessionEntry?.skillsSnapshot,
		systemSent: params.sessionEntry?.systemSent ?? false
	};
	const { sessionEntry, sessionStore, sessionKey, storePath, sessionId, isFirstTurnInSession, workspaceDir, cfg, skillFilter } = params;
	let nextEntry = sessionEntry;
	let systemSent = sessionEntry?.systemSent ?? false;
	const sessionAgentId = resolveSessionAgentId({
		sessionKey,
		config: cfg
	});
	const remoteEligibility = getRemoteSkillEligibility({ advertiseExecNode: canExecRequestNode({
		cfg,
		sessionEntry,
		sessionKey,
		agentId: sessionAgentId
	}) });
	const snapshotVersion = getSkillsSnapshotVersion(workspaceDir);
	const existingSnapshot = nextEntry?.skillsSnapshot;
	ensureSkillsWatcher({
		workspaceDir,
		config: cfg
	});
	const shouldRefreshSnapshot = shouldRefreshSnapshotForVersion(existingSnapshot?.version, snapshotVersion) || !matchesSkillFilter(existingSnapshot?.skillFilter, skillFilter);
	const buildSnapshot = () => buildWorkspaceSkillSnapshot(workspaceDir, {
		config: cfg,
		agentId: sessionAgentId,
		skillFilter,
		eligibility: { remote: remoteEligibility },
		snapshotVersion
	});
	if (isFirstTurnInSession && sessionStore && sessionKey) {
		const current = nextEntry ?? resolveSessionStoreEntry({
			store: sessionStore,
			sessionKey
		}).existing ?? {
			sessionId: sessionId ?? crypto.randomUUID(),
			updatedAt: Date.now()
		};
		const skillSnapshot = !current.skillsSnapshot || shouldRefreshSnapshot ? buildSnapshot() : hydrateResolvedSkills(current.skillsSnapshot, buildSnapshot);
		nextEntry = {
			...current,
			sessionId: sessionId ?? current.sessionId ?? crypto.randomUUID(),
			updatedAt: Date.now(),
			systemSent: true,
			skillsSnapshot: skillSnapshot
		};
		await persistSessionEntryUpdate({
			sessionStore,
			sessionKey,
			storePath,
			nextEntry
		});
		systemSent = true;
	}
	const skillsSnapshot = Boolean(nextEntry?.skillsSnapshot) && (nextEntry?.skillsSnapshot !== existingSnapshot || !shouldRefreshSnapshot) && nextEntry?.skillsSnapshot ? hydrateResolvedSkills(nextEntry.skillsSnapshot, buildSnapshot) : shouldRefreshSnapshot || !nextEntry?.skillsSnapshot ? buildSnapshot() : hydrateResolvedSkills(nextEntry.skillsSnapshot, buildSnapshot);
	if (skillsSnapshot && sessionStore && sessionKey && !isFirstTurnInSession && (!nextEntry?.skillsSnapshot || shouldRefreshSnapshot)) {
		const current = nextEntry ?? {
			sessionId: sessionId ?? crypto.randomUUID(),
			updatedAt: Date.now()
		};
		nextEntry = {
			...current,
			sessionId: sessionId ?? current.sessionId ?? crypto.randomUUID(),
			updatedAt: Date.now(),
			skillsSnapshot
		};
		await persistSessionEntryUpdate({
			sessionStore,
			sessionKey,
			storePath,
			nextEntry
		});
	}
	return {
		sessionEntry: nextEntry,
		skillsSnapshot,
		systemSent
	};
}
async function incrementCompactionCount(params) {
	const { sessionEntry, sessionStore, sessionKey, storePath, cfg, now = Date.now(), amount = 1, tokensAfter, newSessionId, newSessionFile } = params;
	if (!sessionStore || !sessionKey) return;
	const memResolved = resolveSessionStoreEntry({
		store: sessionStore,
		sessionKey
	});
	const entry = memResolved.existing ?? sessionEntry;
	if (!entry) return;
	const incrementBy = Math.max(0, amount);
	const nextCount = (entry.compactionCount ?? 0) + incrementBy;
	const updates = {
		compactionCount: nextCount,
		lastContextPressureBand: void 0,
		updatedAt: now
	};
	const explicitNewSessionFile = normalizeOptionalString(newSessionFile);
	const sessionIdChanged = Boolean(newSessionId && newSessionId !== entry.sessionId);
	const sessionFileChanged = Boolean(explicitNewSessionFile && explicitNewSessionFile !== entry.sessionFile);
	if (sessionIdChanged && newSessionId) {
		updates.sessionId = newSessionId;
		updates.sessionFile = explicitNewSessionFile ?? resolveCompactionSessionFile({
			entry,
			sessionKey,
			storePath,
			newSessionId
		});
		updates.usageFamilyKey = entry.usageFamilyKey ?? sessionKey;
		updates.usageFamilySessionIds = Array.from(new Set([
			...entry.usageFamilySessionIds ?? [],
			entry.sessionId,
			newSessionId
		]));
	} else if (sessionFileChanged && explicitNewSessionFile) updates.sessionFile = explicitNewSessionFile;
	const tokensAfterCompaction = resolvePositiveTokenCount(tokensAfter);
	if (tokensAfterCompaction !== void 0) {
		updates.totalTokens = tokensAfterCompaction;
		updates.totalTokensFresh = true;
		updates.inputTokens = void 0;
		updates.outputTokens = void 0;
		updates.cacheRead = void 0;
		updates.cacheWrite = void 0;
	}
	sessionStore[memResolved.normalizedKey] = mergeSessionEntry(entry, updates);
	for (const legacyKey of memResolved.legacyKeys) delete sessionStore[legacyKey];
	if (storePath) await updateSessionStore(storePath, (store) => {
		const resolved = resolveSessionStoreEntry({
			store,
			sessionKey
		});
		const storedEntry = resolved.existing ?? entry;
		store[resolved.normalizedKey] = mergeSessionEntry(storedEntry, updates);
		for (const legacyKey of resolved.legacyKeys) delete store[legacyKey];
	}, { activeSessionKey: normalizeStoreSessionKey(sessionKey.trim()) });
	if ((sessionIdChanged || sessionFileChanged) && cfg) emitCompactionSessionLifecycleHooks({
		cfg,
		sessionKey,
		storePath,
		previousEntry: entry,
		nextEntry: sessionStore[memResolved.normalizedKey]
	});
	return nextCount;
}
function resolveCompactionSessionFile(params) {
	const pathOpts = resolveSessionFilePathOptions({
		agentId: resolveAgentIdFromSessionKey(params.sessionKey),
		storePath: params.storePath
	});
	const rewrittenSessionFile = rewriteSessionFileForNewSessionId({
		sessionFile: params.entry.sessionFile,
		previousSessionId: params.entry.sessionId,
		nextSessionId: params.newSessionId
	});
	const normalizedRewrittenSessionFile = rewrittenSessionFile && path.isAbsolute(rewrittenSessionFile) ? canonicalizeAbsoluteSessionFilePath(rewrittenSessionFile) : rewrittenSessionFile;
	return resolveSessionFilePath(params.newSessionId, normalizedRewrittenSessionFile ? { sessionFile: normalizedRewrittenSessionFile } : void 0, pathOpts);
}
function canonicalizeAbsoluteSessionFilePath(filePath) {
	const resolved = path.resolve(filePath);
	const missingSegments = [];
	let cursor = resolved;
	while (true) try {
		return path.join(fs.realpathSync(cursor), ...missingSegments.toReversed());
	} catch {
		const parent = path.dirname(cursor);
		if (parent === cursor) return resolved;
		missingSegments.push(path.basename(cursor));
		cursor = parent;
	}
}
function rewriteSessionFileForNewSessionId(params) {
	const trimmed = normalizeOptionalString(params.sessionFile);
	if (!trimmed) return;
	const base = path.basename(trimmed);
	if (!base.endsWith(".jsonl")) return;
	const withoutExt = base.slice(0, -6);
	if (withoutExt === params.previousSessionId) return path.join(path.dirname(trimmed), `${params.nextSessionId}.jsonl`);
	if (withoutExt.startsWith(`${params.previousSessionId}-topic-`)) return path.join(path.dirname(trimmed), `${params.nextSessionId}${base.slice(params.previousSessionId.length)}`);
	const forkMatch = withoutExt.match(/^(\d{4}-\d{2}-\d{2}T[\w-]+(?:Z|[+-]\d{2}(?:-\d{2})?)?)_(.+)$/);
	if (forkMatch?.[2] === params.previousSessionId) return path.join(path.dirname(trimmed), `${forkMatch[1]}_${params.nextSessionId}.jsonl`);
}
//#endregion
export { incrementCompactionCount as n, ensureSkillSnapshot as t };
