import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { _ as resolveSessionAgentId } from "./agent-scope-CtLXGcWm.js";
import { d as resolveAgentIdFromSessionKey } from "./session-key-Bte0mmcq.js";
import { t as matchesSkillFilter } from "./filter-CuPfbjn1.js";
import { r as logVerbose } from "./globals-YU5FjfZK.js";
import { t as getGlobalHookRunner } from "./hook-runner-global-BkXXy1ub.js";
import { a as resolveSessionFilePathOptions, i as resolveSessionFilePath } from "./paths-Bg3PO6Gj.js";
import { u as updateSessionStore } from "./store-BmtchQvp.js";
import { a as canonicalizeAbsoluteSessionFilePath, o as rewriteSessionFileForNewSessionId } from "./sessions-CQHHcgC_.js";
import { t as stableStringify } from "./stable-stringify-TfJ9A6yH.js";
import { o as resolveStableSessionEndTranscript } from "./session-transcript-files.fs-CDIpA7EV.js";
import { t as buildWorkspaceSkillSnapshot } from "./workspace-BoRIIBbL.js";
import "./skills-JUNRkaHl.js";
import { a as buildSessionStartHookPayload, i as buildSessionEndHookPayload, r as noteActiveSessionForShutdown, t as forgetActiveSessionForShutdown } from "./active-sessions-shutdown-tracker-BEPbRoL0.js";
import "./session-system-events-5Yws-hMU.js";
import { t as hydrateResolvedSkills } from "./snapshot-hydration-BZhVc-T2.js";
import { n as getSkillsSnapshotVersion, o as shouldRefreshSnapshotForVersion } from "./refresh-state-PCEDjmSb.js";
import { t as canExecRequestNode } from "./exec-defaults-60zNtKRO.js";
import { t as getRemoteSkillEligibility } from "./skills-remote-BCbpja7h.js";
import { n as ensureSkillsWatcher } from "./refresh-Cu6uIwJm.js";
import path from "node:path";
import crypto from "node:crypto";
//#region src/auto-reply/reply/session-updates.ts
const resolvedSkillsCache = /* @__PURE__ */ new Map();
const RESOLVED_SKILLS_CACHE_MAX = 10;
function isSensitiveConfigKey(key) {
	const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
	return normalized.endsWith("apikey") || normalized.endsWith("token") || normalized.endsWith("secret") || normalized.endsWith("password") || normalized.endsWith("privatekey") || normalized.endsWith("clientsecret");
}
function redactSensitiveConfigValue(value) {
	if (value === void 0 || value === null || value === false || value === "") return value;
	if (typeof value === "string") return value.trim() ? "[redacted:string]" : "";
	if (typeof value === "number") return Number.isFinite(value) && value !== 0 ? "[redacted:number]" : value;
	if (typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.length === 0 ? [] : "[redacted:array]";
	return "[redacted:object]";
}
function redactConfigForSkillSnapshotCache(value, stack = /* @__PURE__ */ new WeakSet()) {
	if (!value || typeof value !== "object") return value;
	if (stack.has(value)) return "[Circular]";
	stack.add(value);
	try {
		if (Array.isArray(value)) return value.map((entry) => redactConfigForSkillSnapshotCache(entry, stack));
		const redacted = {};
		for (const key of Object.keys(value).toSorted()) {
			const field = value[key];
			redacted[key] = isSensitiveConfigKey(key) ? redactSensitiveConfigValue(field) : redactConfigForSkillSnapshotCache(field, stack);
		}
		return redacted;
	} finally {
		stack.delete(value);
	}
}
function fingerprintSkillSnapshotConfig(config) {
	return crypto.createHash("sha256").update(stableStringify(redactConfigForSkillSnapshotCache(config))).digest("hex");
}
function cacheResolvedSkills(cacheKey, snapshot) {
	resolvedSkillsCache.set(cacheKey, snapshot.resolvedSkills);
	if (resolvedSkillsCache.size > RESOLVED_SKILLS_CACHE_MAX) {
		const oldest = resolvedSkillsCache.keys().next().value;
		if (oldest !== void 0) resolvedSkillsCache.delete(oldest);
	}
	return snapshot;
}
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
function resolveNonNegativeTokenCount(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : void 0;
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
	const existingSnapshot = nextEntry?.skillsSnapshot;
	ensureSkillsWatcher({
		workspaceDir,
		config: cfg
	});
	const snapshotVersion = getSkillsSnapshotVersion(workspaceDir);
	const shouldRefreshSnapshot = shouldRefreshSnapshotForVersion(existingSnapshot?.version, snapshotVersion) || !matchesSkillFilter(existingSnapshot?.skillFilter, skillFilter);
	const buildSnapshot = () => {
		return buildWorkspaceSkillSnapshot(workspaceDir, {
			config: cfg,
			agentId: sessionAgentId,
			skillFilter,
			eligibility: { remote: remoteEligibility },
			snapshotVersion
		});
	};
	const configFingerprint = fingerprintSkillSnapshotConfig(cfg);
	const snapshotCacheKey = JSON.stringify([
		workspaceDir,
		snapshotVersion,
		skillFilter,
		sessionAgentId,
		remoteEligibility,
		configFingerprint
	]);
	const cachedRebuild = () => {
		if (resolvedSkillsCache.has(snapshotCacheKey)) return { resolvedSkills: resolvedSkillsCache.get(snapshotCacheKey) };
		return cacheResolvedSkills(snapshotCacheKey, buildSnapshot());
	};
	const buildAndCache = () => cacheResolvedSkills(snapshotCacheKey, buildSnapshot());
	if (isFirstTurnInSession && sessionStore && sessionKey) {
		const current = nextEntry ?? sessionStore[sessionKey] ?? {
			sessionId: sessionId ?? crypto.randomUUID(),
			updatedAt: Date.now()
		};
		const skillSnapshot = !current.skillsSnapshot || shouldRefreshSnapshot ? buildAndCache() : hydrateResolvedSkills(current.skillsSnapshot, cachedRebuild);
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
	const skillsSnapshot = Boolean(nextEntry?.skillsSnapshot) && (nextEntry?.skillsSnapshot !== existingSnapshot || !shouldRefreshSnapshot) && nextEntry?.skillsSnapshot ? hydrateResolvedSkills(nextEntry.skillsSnapshot, cachedRebuild) : shouldRefreshSnapshot || !nextEntry?.skillsSnapshot ? buildAndCache() : hydrateResolvedSkills(nextEntry.skillsSnapshot, cachedRebuild);
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
	const tokensAfterCompaction = resolveNonNegativeTokenCount(tokensAfter);
	if (tokensAfterCompaction !== void 0) {
		updates.totalTokens = tokensAfterCompaction;
		updates.totalTokensFresh = true;
		updates.inputTokens = void 0;
		updates.outputTokens = void 0;
		updates.cacheRead = void 0;
		updates.cacheWrite = void 0;
	} else if (incrementBy > 0) updates.totalTokensFresh = false;
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
//#endregion
export { incrementCompactionCount as n, ensureSkillSnapshot as t };
