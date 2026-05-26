import { f as readStringValue } from "./string-coerce-DyL154ka.js";
import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { n as saveJsonFile, t as loadJsonFile } from "./json-file-DpLhTVdZ.js";
import { o as normalizeDeliveryContext } from "./delivery-context.shared-CBmB9dF7.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
//#region src/agents/subagent-registry-memory.ts
const subagentRuns = /* @__PURE__ */ new Map();
//#endregion
//#region src/agents/subagent-lifecycle-events.ts
const SUBAGENT_TARGET_KIND_SUBAGENT = "subagent";
const SUBAGENT_ENDED_REASON_COMPLETE = "subagent-complete";
const SUBAGENT_ENDED_REASON_ERROR = "subagent-error";
const SUBAGENT_ENDED_REASON_KILLED = "subagent-killed";
const SUBAGENT_ENDED_OUTCOME_ERROR = "error";
const SUBAGENT_ENDED_OUTCOME_TIMEOUT = "timeout";
const SUBAGENT_ENDED_OUTCOME_KILLED = "killed";
//#endregion
//#region src/agents/subagent-session-metrics.ts
function resolveSubagentSessionStartedAtInternal(entry) {
	if (typeof entry.sessionStartedAt === "number" && Number.isFinite(entry.sessionStartedAt)) return entry.sessionStartedAt;
	if (typeof entry.startedAt === "number" && Number.isFinite(entry.startedAt)) return entry.startedAt;
	return typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt) ? entry.createdAt : void 0;
}
function getSubagentSessionStartedAt(entry) {
	return entry ? resolveSubagentSessionStartedAtInternal(entry) : void 0;
}
function getSubagentSessionRuntimeMs(entry, now = Date.now()) {
	if (!entry) return;
	const accumulatedRuntimeMs = typeof entry.accumulatedRuntimeMs === "number" && Number.isFinite(entry.accumulatedRuntimeMs) ? Math.max(0, entry.accumulatedRuntimeMs) : 0;
	if (typeof entry.startedAt !== "number" || !Number.isFinite(entry.startedAt)) return entry.accumulatedRuntimeMs != null ? accumulatedRuntimeMs : void 0;
	const currentRunEndedAt = typeof entry.endedAt === "number" && Number.isFinite(entry.endedAt) ? entry.endedAt : now;
	return Math.max(0, accumulatedRuntimeMs + Math.max(0, currentRunEndedAt - entry.startedAt));
}
function resolveSubagentSessionStatus(entry) {
	if (!entry) return;
	if (!entry.endedAt) return "running";
	if (entry.endedReason === "subagent-killed") return "killed";
	const status = entry.outcome?.status;
	if (status === "error") return "failed";
	if (status === "timeout") return "timeout";
	return "done";
}
//#endregion
//#region src/agents/subagent-run-liveness.ts
const STALE_UNENDED_SUBAGENT_RUN_MS = 7200 * 1e3;
const RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS = 1800 * 1e3;
const EXPLICIT_TIMEOUT_STALE_GRACE_MS = 6e4;
const MIN_REALISTIC_RUN_TIMESTAMP_MS = Date.UTC(2020, 0, 1);
function hasSubagentRunEnded(entry) {
	return typeof entry.endedAt === "number" && Number.isFinite(entry.endedAt);
}
function resolveStaleCutoffMs(entry) {
	const timeoutSeconds = entry.runTimeoutSeconds;
	if (typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) return Math.max(STALE_UNENDED_SUBAGENT_RUN_MS, Math.floor(timeoutSeconds) * 1e3 + EXPLICIT_TIMEOUT_STALE_GRACE_MS);
	return STALE_UNENDED_SUBAGENT_RUN_MS;
}
function isStaleUnendedSubagentRun(entry, now = Date.now()) {
	if (hasSubagentRunEnded(entry)) return false;
	const startedAt = getSubagentSessionStartedAt(entry);
	if (typeof startedAt !== "number" || !Number.isFinite(startedAt) || startedAt < MIN_REALISTIC_RUN_TIMESTAMP_MS) return false;
	return now - startedAt > resolveStaleCutoffMs(entry);
}
function isLiveUnendedSubagentRun(entry, now = Date.now()) {
	return !hasSubagentRunEnded(entry) && !isStaleUnendedSubagentRun(entry, now);
}
function isRecentlyEndedSubagentRun(entry, now = Date.now(), recentMs = RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS) {
	if (!hasSubagentRunEnded(entry)) return false;
	return now - entry.endedAt <= recentMs;
}
function shouldKeepSubagentRunChildLink(entry, options) {
	const now = options?.now ?? Date.now();
	return isLiveUnendedSubagentRun(entry, now) || (options?.activeDescendants ?? 0) > 0 || isRecentlyEndedSubagentRun(entry, now);
}
//#endregion
//#region src/agents/subagent-registry-queries.ts
function resolveControllerSessionKey(entry) {
	return entry.controllerSessionKey?.trim() || entry.requesterSessionKey;
}
function listRunsForRequesterFromRuns(runs, requesterSessionKey, options) {
	const key = requesterSessionKey.trim();
	if (!key) return [];
	const requesterRunId = options?.requesterRunId?.trim();
	const requesterRun = requesterRunId ? runs.get(requesterRunId) : void 0;
	const requesterRunMatchesScope = requesterRun && requesterRun.childSessionKey === key ? requesterRun : void 0;
	const lowerBound = requesterRunMatchesScope?.startedAt ?? requesterRunMatchesScope?.createdAt;
	const upperBound = requesterRunMatchesScope?.endedAt;
	return [...runs.values()].filter((entry) => {
		if (entry.requesterSessionKey !== key) return false;
		if (typeof lowerBound === "number" && entry.createdAt < lowerBound) return false;
		if (typeof upperBound === "number" && entry.createdAt > upperBound) return false;
		return true;
	});
}
function listRunsForControllerFromRuns(runs, controllerSessionKey) {
	const key = controllerSessionKey.trim();
	if (!key) return [];
	return [...runs.values()].filter((entry) => resolveControllerSessionKey(entry) === key);
}
function rememberLatestRunEntry(map, key, entry) {
	const existing = map.get(key);
	if (!existing || entry.createdAt > existing.createdAt) map.set(key, entry);
}
function rememberLatestRunPair(map, key, runId, entry) {
	const existing = map.get(key);
	if (!existing || entry.createdAt > existing.entry.createdAt) map.set(key, {
		runId,
		entry
	});
}
function buildSubagentRunReadIndexFromRuns(params) {
	const { runs } = params;
	const now = params.now ?? Date.now();
	const inMemoryDisplayByChildSessionKey = /* @__PURE__ */ new Map();
	const latestSnapshotActiveByChildSessionKey = /* @__PURE__ */ new Map();
	const latestSnapshotEndedByChildSessionKey = /* @__PURE__ */ new Map();
	const latestRunByChildSessionKey = /* @__PURE__ */ new Map();
	const runsByControllerSessionKey = /* @__PURE__ */ new Map();
	const latestRunByRequesterAndChildSessionKey = /* @__PURE__ */ new Map();
	const activeDescendantCountBySessionKey = /* @__PURE__ */ new Map();
	for (const entry of params.inMemoryRuns ?? []) {
		const childSessionKey = entry.childSessionKey.trim();
		if (!childSessionKey) continue;
		let display = inMemoryDisplayByChildSessionKey.get(childSessionKey);
		if (!display) {
			display = {
				latestInMemoryActive: null,
				latestInMemoryEnded: null
			};
			inMemoryDisplayByChildSessionKey.set(childSessionKey, display);
		}
		if (hasSubagentRunEnded(entry)) {
			if (!display.latestInMemoryEnded || entry.createdAt > display.latestInMemoryEnded.createdAt) display.latestInMemoryEnded = entry;
			continue;
		}
		if (!display.latestInMemoryActive || entry.createdAt > display.latestInMemoryActive.createdAt) display.latestInMemoryActive = entry;
	}
	for (const [runId, entry] of runs.entries()) {
		const childSessionKey = entry.childSessionKey.trim();
		const controllerSessionKey = resolveControllerSessionKey(entry);
		if (controllerSessionKey) {
			let controllerRuns = runsByControllerSessionKey.get(controllerSessionKey);
			if (!controllerRuns) {
				controllerRuns = [];
				runsByControllerSessionKey.set(controllerSessionKey, controllerRuns);
			}
			controllerRuns.push(entry);
		}
		if (!childSessionKey) continue;
		if (isLiveUnendedSubagentRun(entry, now)) rememberLatestRunEntry(latestSnapshotActiveByChildSessionKey, childSessionKey, entry);
		else rememberLatestRunEntry(latestSnapshotEndedByChildSessionKey, childSessionKey, entry);
		rememberLatestRunPair(latestRunByChildSessionKey, childSessionKey, runId, entry);
		const requesterSessionKey = entry.requesterSessionKey;
		if (!requesterSessionKey) continue;
		let latestByChild = latestRunByRequesterAndChildSessionKey.get(requesterSessionKey);
		if (!latestByChild) {
			latestByChild = /* @__PURE__ */ new Map();
			latestRunByRequesterAndChildSessionKey.set(requesterSessionKey, latestByChild);
		}
		rememberLatestRunPair(latestByChild, childSessionKey, runId, entry);
	}
	const getDisplaySubagentRun = (childSessionKey) => {
		const key = childSessionKey.trim();
		if (!key) return null;
		const inMemoryDisplay = inMemoryDisplayByChildSessionKey.get(key);
		if (inMemoryDisplay) {
			const latestInMemoryEnded = inMemoryDisplay.latestInMemoryEnded;
			const latestInMemoryActive = inMemoryDisplay.latestInMemoryActive;
			if (latestInMemoryEnded || latestInMemoryActive) {
				if (latestInMemoryEnded && (!latestInMemoryActive || latestInMemoryEnded.createdAt > latestInMemoryActive.createdAt)) return latestInMemoryEnded;
				return latestInMemoryActive ?? latestInMemoryEnded;
			}
		}
		return latestSnapshotActiveByChildSessionKey.get(key) ?? latestSnapshotEndedByChildSessionKey.get(key) ?? null;
	};
	const countActiveDescendantRuns = (rootSessionKey) => {
		const root = rootSessionKey.trim();
		if (!root) return 0;
		if (activeDescendantCountBySessionKey.has(root)) return activeDescendantCountBySessionKey.get(root) ?? 0;
		let count = 0;
		const pending = [root];
		const visited = new Set([root]);
		for (let index = 0; index < pending.length; index += 1) {
			const requester = pending[index];
			if (!requester) continue;
			const latestByChild = latestRunByRequesterAndChildSessionKey.get(requester);
			if (!latestByChild) continue;
			for (const [childSessionKey, pair] of latestByChild.entries()) {
				const latestForChildSession = latestRunByChildSessionKey.get(childSessionKey);
				if (!latestForChildSession || latestForChildSession.runId !== pair.runId || latestForChildSession.entry.requesterSessionKey !== requester) continue;
				if (isLiveUnendedSubagentRun(pair.entry, now)) count += 1;
				if (!childSessionKey || visited.has(childSessionKey)) continue;
				visited.add(childSessionKey);
				pending.push(childSessionKey);
			}
		}
		activeDescendantCountBySessionKey.set(root, count);
		return count;
	};
	return {
		getDisplaySubagentRun,
		countActiveDescendantRuns,
		runsByControllerSessionKey
	};
}
function findLatestRunForChildSession(runs, childSessionKey) {
	const key = childSessionKey.trim();
	if (!key) return;
	let latest;
	for (const entry of runs.values()) {
		if (entry.childSessionKey !== key) continue;
		if (!latest || entry.createdAt > latest.createdAt) latest = entry;
	}
	return latest;
}
function isSubagentSessionRunActiveFromRuns(runs, childSessionKey) {
	const latest = findLatestRunForChildSession(runs, childSessionKey);
	return Boolean(latest && isLiveUnendedSubagentRun(latest));
}
function getSubagentRunByChildSessionKeyFromRuns(runs, childSessionKey) {
	const key = childSessionKey.trim();
	if (!key) return null;
	let latestActive = null;
	let latestEnded = null;
	for (const entry of runs.values()) {
		if (entry.childSessionKey !== key) continue;
		if (isLiveUnendedSubagentRun(entry)) {
			if (!latestActive || entry.createdAt > latestActive.createdAt) latestActive = entry;
			continue;
		}
		if (!latestEnded || entry.createdAt > latestEnded.createdAt) latestEnded = entry;
	}
	return latestActive ?? latestEnded;
}
function resolveRequesterForChildSessionFromRuns(runs, childSessionKey) {
	const latest = findLatestRunForChildSession(runs, childSessionKey);
	if (!latest) return null;
	return {
		requesterSessionKey: latest.requesterSessionKey,
		requesterOrigin: latest.requesterOrigin
	};
}
function shouldIgnorePostCompletionAnnounceForSessionFromRuns(runs, childSessionKey) {
	const latest = findLatestRunForChildSession(runs, childSessionKey);
	return Boolean(latest && latest.spawnMode !== "session" && typeof latest.endedAt === "number" && typeof latest.cleanupCompletedAt === "number" && latest.cleanupCompletedAt >= latest.endedAt);
}
function countActiveRunsForSessionFromRuns(runs, controllerSessionKey) {
	const key = controllerSessionKey.trim();
	if (!key) return 0;
	const pendingDescendantCache = /* @__PURE__ */ new Map();
	const pendingDescendantCount = (sessionKey) => {
		if (pendingDescendantCache.has(sessionKey)) return pendingDescendantCache.get(sessionKey) ?? 0;
		const pending = countPendingDescendantRunsInternal(runs, sessionKey);
		pendingDescendantCache.set(sessionKey, pending);
		return pending;
	};
	const latestByChildSessionKey = /* @__PURE__ */ new Map();
	for (const entry of runs.values()) {
		if (resolveControllerSessionKey(entry) !== key) continue;
		const existing = latestByChildSessionKey.get(entry.childSessionKey);
		if (!existing || entry.createdAt > existing.createdAt) latestByChildSessionKey.set(entry.childSessionKey, entry);
	}
	let count = 0;
	for (const entry of latestByChildSessionKey.values()) {
		if (isLiveUnendedSubagentRun(entry)) {
			count += 1;
			continue;
		}
		if (pendingDescendantCount(entry.childSessionKey) > 0) count += 1;
	}
	return count;
}
function forEachDescendantRun(runs, rootSessionKey, visitor) {
	const root = rootSessionKey.trim();
	if (!root) return false;
	const pending = [root];
	const visited = new Set([root]);
	for (let index = 0; index < pending.length; index += 1) {
		const requester = pending[index];
		if (!requester) continue;
		const latestByChildSessionKey = /* @__PURE__ */ new Map();
		for (const [runId, entry] of runs.entries()) {
			if (entry.requesterSessionKey !== requester) continue;
			const childKey = entry.childSessionKey.trim();
			const existing = latestByChildSessionKey.get(childKey);
			if (!existing || entry.createdAt > existing[1].createdAt) latestByChildSessionKey.set(childKey, [runId, entry]);
		}
		for (const [runId, entry] of latestByChildSessionKey.values()) {
			const latestForChildSession = findLatestRunForChildSession(runs, entry.childSessionKey);
			if (!latestForChildSession || latestForChildSession.runId !== runId || latestForChildSession.requesterSessionKey !== requester) continue;
			visitor(runId, entry);
			const childKey = entry.childSessionKey.trim();
			if (!childKey || visited.has(childKey)) continue;
			visited.add(childKey);
			pending.push(childKey);
		}
	}
	return true;
}
function countActiveDescendantRunsFromRuns(runs, rootSessionKey) {
	let count = 0;
	if (!forEachDescendantRun(runs, rootSessionKey, (_runId, entry) => {
		if (isLiveUnendedSubagentRun(entry)) count += 1;
	})) return 0;
	return count;
}
function countPendingDescendantRunsInternal(runs, rootSessionKey, excludeRunId) {
	const excludedRunId = excludeRunId?.trim();
	let count = 0;
	if (!forEachDescendantRun(runs, rootSessionKey, (runId, entry) => {
		const runEnded = hasSubagentRunEnded(entry);
		const cleanupCompleted = typeof entry.cleanupCompletedAt === "number";
		if ((runEnded ? !cleanupCompleted : isLiveUnendedSubagentRun(entry)) && runId !== excludedRunId) count += 1;
	})) return 0;
	return count;
}
function countPendingDescendantRunsFromRuns(runs, rootSessionKey) {
	return countPendingDescendantRunsInternal(runs, rootSessionKey);
}
function countPendingDescendantRunsExcludingRunFromRuns(runs, rootSessionKey, excludeRunId) {
	return countPendingDescendantRunsInternal(runs, rootSessionKey, excludeRunId);
}
function listDescendantRunsForRequesterFromRuns(runs, rootSessionKey) {
	const descendants = [];
	if (!forEachDescendantRun(runs, rootSessionKey, (_runId, entry) => {
		descendants.push(entry);
	})) return [];
	return descendants;
}
//#endregion
//#region src/agents/subagent-registry.store.ts
const REGISTRY_VERSION = 2;
const MAX_SUBAGENT_REGISTRY_READ_CACHE_ENTRIES = 32;
const registryReadCache = /* @__PURE__ */ new Map();
function cloneSubagentRunRecord(entry) {
	return structuredClone(entry);
}
function cloneSubagentRunMap(runs) {
	return new Map([...runs].map(([runId, entry]) => [runId, cloneSubagentRunRecord(entry)]));
}
function setCachedRegistryRead(pathname, signature, runs) {
	registryReadCache.delete(pathname);
	registryReadCache.set(pathname, {
		signature,
		runs: cloneSubagentRunMap(runs)
	});
	if (registryReadCache.size <= MAX_SUBAGENT_REGISTRY_READ_CACHE_ENTRIES) return;
	const oldestKey = registryReadCache.keys().next().value;
	if (typeof oldestKey === "string") registryReadCache.delete(oldestKey);
}
function resolveSubagentStateDir(env = process.env) {
	if (env.OPENCLAW_STATE_DIR?.trim()) return resolveStateDir(env);
	if (env.VITEST || env.NODE_ENV === "test") return path.join(os.tmpdir(), "openclaw-test-state", String(process.pid));
	return resolveStateDir(env);
}
function resolveSubagentRegistryPath() {
	return path.join(resolveSubagentStateDir(process.env), "subagents", "runs.json");
}
function loadSubagentRegistryFromDisk() {
	const pathname = resolveSubagentRegistryPath();
	const signature = statRegistryFileSignature(pathname);
	if (signature === null) {
		registryReadCache.delete(pathname);
		return /* @__PURE__ */ new Map();
	}
	const cached = registryReadCache.get(pathname);
	if (cached?.signature === signature) {
		registryReadCache.delete(pathname);
		registryReadCache.set(pathname, cached);
		return cloneSubagentRunMap(cached.runs);
	}
	const raw = loadJsonFile(pathname);
	if (!raw || typeof raw !== "object") {
		setCachedRegistryRead(pathname, signature, /* @__PURE__ */ new Map());
		return /* @__PURE__ */ new Map();
	}
	const record = raw;
	if (record.version !== 1 && record.version !== 2) {
		setCachedRegistryRead(pathname, signature, /* @__PURE__ */ new Map());
		return /* @__PURE__ */ new Map();
	}
	const runsRaw = record.runs;
	if (!runsRaw || typeof runsRaw !== "object") {
		setCachedRegistryRead(pathname, signature, /* @__PURE__ */ new Map());
		return /* @__PURE__ */ new Map();
	}
	const out = /* @__PURE__ */ new Map();
	const isLegacy = record.version === 1;
	let migrated = false;
	for (const [runId, entry] of Object.entries(runsRaw)) {
		if (!entry || typeof entry !== "object") continue;
		const typed = entry;
		if (!typed.runId || typeof typed.runId !== "string") continue;
		const legacyCompletedAt = isLegacy && typeof typed.announceCompletedAt === "number" ? typed.announceCompletedAt : void 0;
		const cleanupCompletedAt = typeof typed.cleanupCompletedAt === "number" ? typed.cleanupCompletedAt : legacyCompletedAt;
		const cleanupHandled = typeof typed.cleanupHandled === "boolean" ? typed.cleanupHandled : isLegacy ? Boolean(typed.announceHandled ?? cleanupCompletedAt) : void 0;
		const requesterOrigin = normalizeDeliveryContext(typed.requesterOrigin ?? {
			channel: readStringValue(typed.requesterChannel),
			accountId: readStringValue(typed.requesterAccountId)
		});
		const childSessionKey = readStringValue(typed.childSessionKey)?.trim() ?? "";
		const requesterSessionKey = readStringValue(typed.requesterSessionKey)?.trim() ?? "";
		const controllerSessionKey = readStringValue(typed.controllerSessionKey)?.trim() || requesterSessionKey;
		if (!childSessionKey || !requesterSessionKey) continue;
		const { announceCompletedAt: _announceCompletedAt, announceHandled: _announceHandled, requesterChannel: _channel, requesterAccountId: _accountId, ...rest } = typed;
		out.set(runId, {
			...rest,
			childSessionKey,
			requesterSessionKey,
			controllerSessionKey,
			requesterOrigin,
			cleanupCompletedAt,
			cleanupHandled,
			spawnMode: typed.spawnMode === "session" ? "session" : "run"
		});
		if (isLegacy) migrated = true;
	}
	if (migrated) try {
		saveSubagentRegistryToDisk(out);
	} catch {}
	else setCachedRegistryRead(pathname, signature, out);
	return out;
}
function saveSubagentRegistryToDisk(runs) {
	const pathname = resolveSubagentRegistryPath();
	const serialized = {};
	for (const [runId, entry] of runs.entries()) serialized[runId] = entry;
	saveJsonFile(pathname, {
		version: REGISTRY_VERSION,
		runs: serialized
	});
	const signature = statRegistryFileSignature(pathname);
	if (signature === null) registryReadCache.delete(pathname);
	else setCachedRegistryRead(pathname, signature, runs);
}
function statRegistryFileSignature(pathname) {
	try {
		const stat = fs.statSync(pathname, { bigint: true });
		if (!stat.isFile()) return null;
		return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}
//#endregion
//#region src/agents/subagent-registry-state.ts
function persistSubagentRunsToDisk(runs) {
	try {
		saveSubagentRegistryToDisk(runs);
	} catch {}
}
function persistSubagentRunsToDiskOrThrow(runs) {
	saveSubagentRegistryToDisk(runs);
}
function restoreSubagentRunsFromDisk(params) {
	const restored = loadSubagentRegistryFromDisk();
	if (restored.size === 0) return 0;
	let added = 0;
	for (const [runId, entry] of restored.entries()) {
		if (!runId || !entry) continue;
		if (params.mergeOnly && params.runs.has(runId)) continue;
		params.runs.set(runId, entry);
		added += 1;
	}
	return added;
}
function getSubagentRunsSnapshotForRead(inMemoryRuns) {
	const merged = /* @__PURE__ */ new Map();
	if (process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK === "1" || !(process.env.VITEST || false)) try {
		for (const [runId, entry] of loadSubagentRegistryFromDisk().entries()) merged.set(runId, entry);
	} catch {}
	for (const [runId, entry] of inMemoryRuns.entries()) merged.set(runId, entry);
	return merged;
}
//#endregion
export { SUBAGENT_ENDED_REASON_KILLED as A, getSubagentSessionStartedAt as C, SUBAGENT_ENDED_OUTCOME_TIMEOUT as D, SUBAGENT_ENDED_OUTCOME_KILLED as E, subagentRuns as M, SUBAGENT_ENDED_REASON_COMPLETE as O, getSubagentSessionRuntimeMs as S, SUBAGENT_ENDED_OUTCOME_ERROR as T, RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS as _, buildSubagentRunReadIndexFromRuns as a, isStaleUnendedSubagentRun as b, countPendingDescendantRunsExcludingRunFromRuns as c, isSubagentSessionRunActiveFromRuns as d, listDescendantRunsForRequesterFromRuns as f, shouldIgnorePostCompletionAnnounceForSessionFromRuns as g, resolveRequesterForChildSessionFromRuns as h, restoreSubagentRunsFromDisk as i, SUBAGENT_TARGET_KIND_SUBAGENT as j, SUBAGENT_ENDED_REASON_ERROR as k, countPendingDescendantRunsFromRuns as l, listRunsForRequesterFromRuns as m, persistSubagentRunsToDisk as n, countActiveDescendantRunsFromRuns as o, listRunsForControllerFromRuns as p, persistSubagentRunsToDiskOrThrow as r, countActiveRunsForSessionFromRuns as s, getSubagentRunsSnapshotForRead as t, getSubagentRunByChildSessionKeyFromRuns as u, hasSubagentRunEnded as v, resolveSubagentSessionStatus as w, shouldKeepSubagentRunChildLink as x, isLiveUnendedSubagentRun as y };
