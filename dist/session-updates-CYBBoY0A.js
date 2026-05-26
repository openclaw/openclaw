import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { u as resolveAgentIdFromSessionKey } from "./session-key-DFEyR49L.js";
import { t as matchesSkillFilter } from "./filter-_6eE5RKS.js";
import { p as resolveSessionAgentId } from "./agent-scope-C1Fl7gAf.js";
import { r as logVerbose } from "./globals-CouSpJO4.js";
import { t as getGlobalHookRunner } from "./hook-runner-global-aUo3QVZe.js";
import { a as resolveSessionFilePathOptions, i as resolveSessionFilePath } from "./paths-kGAxo7MN.js";
import { s as updateSessionStore } from "./store-3qAZ3Zl6.js";
import "./sessions-BhOk6siH.js";
import { o as resolveStableSessionEndTranscript } from "./session-transcript-files.fs-BllhWpEO.js";
import { t as buildWorkspaceSkillSnapshot } from "./workspace-CWHANolf.js";
import "./skills-Cc0UgUNL.js";
import { a as buildSessionStartHookPayload, i as buildSessionEndHookPayload, r as noteActiveSessionForShutdown, t as forgetActiveSessionForShutdown } from "./active-sessions-shutdown-tracker-CxbFjg5W.js";
import "./session-system-events-CRnz5Kej.js";
import { t as hydrateResolvedSkills } from "./snapshot-hydration-cKF9lnUH.js";
import { n as getSkillsSnapshotVersion, o as shouldRefreshSnapshotForVersion } from "./refresh-state-CJpHWFGC.js";
import { t as canExecRequestNode } from "./exec-defaults-CwIA892j.js";
import { t as getRemoteSkillEligibility } from "./skills-remote-sP-UA4tV.js";
import { n as ensureSkillsWatcher } from "./refresh-BW1b9YiQ.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
//#region src/auto-reply/reply/session-updates.ts
async function persistSessionEntryUpdate(params) {
	if (!params.sessionStore || !params.sessionKey) return;
	params.sessionStore[params.sessionKey] = {
		...params.sessionStore[params.sessionKey],
		...params.nextEntry
	};
	if (!params.storePath) return;
	await updateSessionStore(params.storePath, (store) => {
		store[params.sessionKey] = {
			...store[params.sessionKey],
			...params.nextEntry
		};
	});
}
function emitCompactionSessionLifecycleHooks(params) {
	if (params.previousEntry.sessionId) forgetActiveSessionForShutdown(params.previousEntry.sessionId);
	if (params.nextEntry.sessionId && params.storePath) noteActiveSessionForShutdown({
		cfg: params.cfg,
		sessionKey: params.sessionKey,
		sessionId: params.nextEntry.sessionId,
		storePath: params.storePath,
		sessionFile: params.nextEntry.sessionFile,
		agentId: resolveAgentIdFromSessionKey(params.sessionKey)
	});
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
		const current = nextEntry ?? sessionStore[sessionKey] ?? {
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
	const entry = sessionStore[sessionKey] ?? sessionEntry;
	if (!entry) return;
	const incrementBy = Math.max(0, amount);
	const nextCount = (entry.compactionCount ?? 0) + incrementBy;
	const updates = {
		compactionCount: nextCount,
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
	sessionStore[sessionKey] = {
		...entry,
		...updates
	};
	if (storePath) await updateSessionStore(storePath, (store) => {
		store[sessionKey] = {
			...store[sessionKey],
			...updates
		};
	});
	if ((sessionIdChanged || sessionFileChanged) && cfg) emitCompactionSessionLifecycleHooks({
		cfg,
		sessionKey,
		storePath,
		previousEntry: entry,
		nextEntry: sessionStore[sessionKey]
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
