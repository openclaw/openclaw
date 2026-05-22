import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { _ as resolveSessionAgentId } from "./agent-scope-rw2bYM9R.js";
import { u as resolveAgentIdFromSessionKey } from "./session-key-CQewiu8n.js";
import { t as matchesSkillFilter } from "./filter-C6LM1yyQ.js";
import { n as defaultRuntime } from "./runtime-DDH_zqCr.js";
import { r as logVerbose } from "./globals-DaPK6X5S.js";
import { t as getGlobalHookRunner } from "./hook-runner-global-Cd2Qar9Y.js";
import { a as resolveSessionFilePathOptions, i as resolveSessionFilePath } from "./paths-_BPRx1WO.js";
import { A as resolveSessionStoreEntry, k as normalizeStoreSessionKey } from "./store-load-NR217KeP.js";
import { s as updateSessionStore } from "./store-DM2Qj4Ie.js";
import { n as mergeSessionEntry } from "./types-_KZG4WBE.js";
import { a as canonicalizeAbsoluteSessionFilePath, o as rewriteSessionFileForNewSessionId } from "./sessions-Buwioyq3.js";
import { t as stableStringify } from "./stable-stringify-DlXUsXSs.js";
import { o as resolveStableSessionEndTranscript } from "./session-transcript-files.fs-DNsl4mXc.js";
import { i as resolveUserTimezone } from "./date-time-OFfXKzFY.js";
import { o as emitContinuationQueueDrainSpan } from "./continuation-tracer-BMyqgPEb.js";
import { c as peekSystemEventEntries, t as consumeSelectedSystemEventEntries } from "./system-events-CvlpBn9J.js";
import { t as ackSessionDelivery } from "./session-delivery-queue-storage-BKJP2MpR.js";
import { t as buildWorkspaceSkillSnapshot } from "./workspace-BsbOMA6r.js";
import "./skills-DaAO3VHR.js";
import { t as canExecRequestNode } from "./exec-defaults-Cv4SkCuH.js";
import { n as getSkillsSnapshotVersion, o as shouldRefreshSnapshotForVersion } from "./refresh-state-BXYZ5dQv.js";
import { n as ensureSkillsWatcher } from "./refresh-DV6QO1pA.js";
import { t as hydrateResolvedSkills } from "./snapshot-hydration-D9rq7Sn5.js";
import { a as noteActiveSessionForShutdown, n as buildSessionStartHookPayload, r as forgetActiveSessionForShutdown, t as buildSessionEndHookPayload } from "./session-hooks-Cj5RH4gQ.js";
import { t as getRemoteSkillEligibility } from "./skills-remote-BS6dA4jK.js";
import { t as buildChannelSummary } from "./channel-summary-D3E4JHt2.js";
import { n as formatZonedTimestamp, r as resolveTimezone, t as formatUtcTimestamp } from "./format-datetime-SitBVac0.js";
import { i as isExecCompletionEvent } from "./heartbeat-events-filter-edWSlyBk.js";
import path from "node:path";
import crypto from "node:crypto";
//#region src/auto-reply/reply/session-system-events.ts
const selectGenericSystemEvents = (events) => {
	const selected = [];
	for (const event of events) if (!isExecCompletionEvent(event.text)) selected.push(event);
	return selected;
};
async function ackDrainedSessionDeliveries(events) {
	for (const event of events) {
		if (!event.sessionDeliveryAckId) continue;
		try {
			await ackSessionDelivery(event.sessionDeliveryAckId, event.sessionDeliveryAckStateDir);
		} catch (err) {
			defaultRuntime.log(`Failed to ack drained session delivery ${event.sessionDeliveryAckId}: ${String(err)}`);
		}
	}
}
/** Drain queued system events, format as `System:` lines, return the block with authority metadata. */
async function drainFormattedSystemEventBlock(params) {
	const compactSystemEvent = (line) => {
		const trimmed = line.trim();
		if (!trimmed) return null;
		const lower = normalizeLowercaseStringOrEmpty(trimmed);
		if (lower.includes("reason periodic")) return null;
		if (lower.startsWith("read heartbeat.md")) return null;
		if (lower.includes("heartbeat poll") || lower.includes("heartbeat wake")) return null;
		if (trimmed.startsWith("Node:")) return trimmed.replace(/ · last input [^·]+/i, "").trim();
		return trimmed;
	};
	const resolveSystemEventTimezone = (cfg) => {
		const raw = normalizeOptionalString(cfg.agents?.defaults?.envelopeTimezone);
		if (!raw) return { mode: "local" };
		const lowered = normalizeLowercaseStringOrEmpty(raw);
		if (lowered === "utc" || lowered === "gmt") return { mode: "utc" };
		if (lowered === "local" || lowered === "host") return { mode: "local" };
		if (lowered === "user") return {
			mode: "iana",
			timeZone: resolveUserTimezone(cfg.agents?.defaults?.userTimezone)
		};
		const explicit = resolveTimezone(raw);
		return explicit ? {
			mode: "iana",
			timeZone: explicit
		} : { mode: "local" };
	};
	const formatSystemEventTimestamp = (ts, cfg) => {
		const date = new Date(ts);
		if (Number.isNaN(date.getTime())) return "unknown-time";
		const zone = resolveSystemEventTimezone(cfg);
		if (zone.mode === "utc") return formatUtcTimestamp(date, { displaySeconds: true });
		if (zone.mode === "local") return formatZonedTimestamp(date, { displaySeconds: true }) ?? "unknown-time";
		return formatZonedTimestamp(date, {
			timeZone: zone.timeZone,
			displaySeconds: true
		}) ?? "unknown-time";
	};
	const summaryLines = [];
	const systemLines = [];
	let forceSenderIsOwnerFalse = false;
	const queued = consumeSelectedSystemEventEntries(params.sessionKey, selectGenericSystemEvents(peekSystemEventEntries(params.sessionKey)));
	await ackDrainedSessionDeliveries(queued);
	const drainedContinuationCount = queued.filter((event) => event.text.startsWith("[continuation:")).length;
	const traceparent = queued.find((event) => event.traceparent)?.traceparent;
	emitContinuationQueueDrainSpan({
		drainedCount: queued.length,
		drainedContinuationCount,
		...traceparent ? { traceparent } : {},
		log: (message) => defaultRuntime.log(message)
	});
	systemLines.push(...queued.flatMap((event) => {
		const compacted = compactSystemEvent(event.text);
		if (!compacted) return [];
		if (event.forceSenderIsOwnerFalse === true) forceSenderIsOwnerFalse = true;
		const prefix = event.trusted === false ? "System (untrusted)" : "System";
		const timestamp = `[${formatSystemEventTimestamp(event.ts, params.cfg)}]`;
		return compacted.split("\n").map((subline, index) => `${prefix}: ${index === 0 ? `${timestamp} ` : ""}${subline}`);
	}));
	if (params.isMainSession && params.isNewSession) {
		const summary = await buildChannelSummary(params.cfg);
		if (summary.length > 0) for (const line of summary) for (const subline of line.split("\n")) summaryLines.push(`System: ${subline}`);
	}
	if (summaryLines.length === 0 && systemLines.length === 0) return;
	return {
		text: summaryLines.length > 0 ? [...summaryLines, ...systemLines].join("\n") : systemLines.join("\n"),
		forceSenderIsOwnerFalse
	};
}
//#endregion
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
		const current = nextEntry ?? resolveSessionStoreEntry({
			store: sessionStore,
			sessionKey
		}).existing ?? {
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
	} else if (incrementBy > 0) updates.totalTokensFresh = false;
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
//#endregion
export { incrementCompactionCount as n, drainFormattedSystemEventBlock as r, ensureSkillSnapshot as t };
