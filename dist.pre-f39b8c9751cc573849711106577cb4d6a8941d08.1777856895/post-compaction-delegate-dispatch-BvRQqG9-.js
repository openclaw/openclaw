import { v as resolveStateDir } from "./paths-C1_Y0cDn.js";
import { i as formatErrorMessage$1 } from "./errors-QN8rySzW.js";
import { n as defaultRuntime } from "./runtime-Dv8n03pi.js";
import { p as resolveSessionAgentId, x as resolveAgentWorkspaceDir } from "./agent-scope-CzfWAE9r.js";
import { i as getRuntimeConfig } from "./io-DJ0qH7nz.js";
import "./config-BxdAfCU3.js";
import { u as resolveStorePath } from "./paths-CJq5T6t4.js";
import { t as loadSessionStore } from "./store-load-CPVa0fsE.js";
import { o as updateSessionStore, p as resolveSessionStoreEntry } from "./store-C0WV070A.js";
import { n as spawnSubagentDirect } from "./subagent-spawn-DpikmHBB.js";
import { j as readPostCompactionContext } from "./compaction-successor-transcript-ByyzUmDl.js";
import { o as generateSecureUuid, t as generateChainId } from "./secure-random-DJVw9xqK.js";
import { n as resolveContinuationRuntimeConfig } from "./config-5i0YqEIQ.js";
import { a as enqueueSystemEvent } from "./system-events-Djz7KlwF.js";
import { t as consumeStagedPostCompactionDelegates } from "./continuation-delegate-store-BlU9S5zR.js";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
//#region src/infra/session-delivery-queue-storage.ts
const QUEUE_DIRNAME = "session-delivery-queue";
const FAILED_DIRNAME = "failed";
const TMP_SWEEP_MAX_AGE_MS = 5e3;
var SessionDeliveryQueueOverflowError = class extends Error {
	constructor(count, maxFiles) {
		super(`session-delivery-queue overflow: ${count} queued files at top level, soft-cap is ${maxFiles}`);
		this.kind = "session-delivery-queue-overflow";
		this.name = "SessionDeliveryQueueOverflowError";
		this.count = count;
		this.maxFiles = maxFiles;
	}
};
function getErrnoCode$1(err) {
	return err && typeof err === "object" && "code" in err ? String(err.code) : null;
}
function canonicalizeIdempotencyKey(key) {
	return key.replace(/[ \t\r\f\v]+(?=\n|$)/g, "").replace(/\s+$/, "");
}
function buildEntryId(idempotencyKey) {
	if (!idempotencyKey) return generateSecureUuid();
	return createHash("sha256").update(canonicalizeIdempotencyKey(idempotencyKey)).digest("hex");
}
function buildPostCompactionDelegateIdempotencyKey(params) {
	const taskHash = createHash("sha256").update(params.delegate.task).digest("hex").slice(0, 16);
	return [
		"post-compaction-delegate",
		params.sessionKey,
		String(params.compactionCount ?? "unknown"),
		String(params.delegate.firstArmedAt ?? params.delegate.createdAt),
		String(params.sequence),
		taskHash
	].join(":");
}
function buildPostCompactionDelegateDeliveryPayload(params) {
	return {
		kind: "postCompactionDelegate",
		sessionKey: params.sessionKey,
		task: params.delegate.task,
		createdAt: params.delegate.createdAt,
		firstArmedAt: params.delegate.firstArmedAt ?? params.delegate.createdAt,
		...params.delegate.silent != null ? { silent: params.delegate.silent } : {},
		...params.delegate.silentWake != null ? { silentWake: params.delegate.silentWake } : {},
		...params.deliveryContext ? { deliveryContext: params.deliveryContext } : {},
		idempotencyKey: params.idempotencyKey ?? buildPostCompactionDelegateIdempotencyKey({
			sessionKey: params.sessionKey,
			delegate: params.delegate,
			sequence: params.sequence,
			compactionCount: params.compactionCount
		})
	};
}
async function unlinkBestEffort(filePath) {
	await fs.promises.unlink(filePath).catch(() => void 0);
}
async function unlinkStaleTmpBestEffort(filePath, now) {
	try {
		const stat = await fs.promises.stat(filePath);
		if (!stat.isFile()) return;
		if (now - stat.mtimeMs < TMP_SWEEP_MAX_AGE_MS) return;
		await unlinkBestEffort(filePath);
	} catch (err) {
		if (getErrnoCode$1(err) !== "ENOENT") throw err;
	}
}
async function writeQueueEntry(filePath, entry) {
	const tmp = `${filePath}.${process.pid}.tmp`;
	await fs.promises.writeFile(tmp, JSON.stringify(entry, null, 2), {
		encoding: "utf-8",
		mode: 384
	});
	await fs.promises.rename(tmp, filePath);
}
async function readQueueEntry(filePath) {
	return JSON.parse(await fs.promises.readFile(filePath, "utf-8"));
}
function resolveSessionDeliveryQueueDir(stateDir) {
	const base = stateDir ?? resolveStateDir();
	return path.join(base, QUEUE_DIRNAME);
}
function resolveFailedDir(stateDir) {
	return path.join(resolveSessionDeliveryQueueDir(stateDir), FAILED_DIRNAME);
}
function resolveQueueEntryPaths(id, stateDir) {
	const queueDir = resolveSessionDeliveryQueueDir(stateDir);
	return {
		jsonPath: path.join(queueDir, `${id}.json`),
		deliveredPath: path.join(queueDir, `${id}.delivered`)
	};
}
async function ensureSessionDeliveryQueueDir(stateDir) {
	const queueDir = resolveSessionDeliveryQueueDir(stateDir);
	await fs.promises.mkdir(queueDir, {
		recursive: true,
		mode: 448
	});
	await fs.promises.mkdir(resolveFailedDir(stateDir), {
		recursive: true,
		mode: 448
	});
	return queueDir;
}
async function countQueuedFiles(queueDir) {
	let entries;
	try {
		entries = await fs.promises.readdir(queueDir);
	} catch (err) {
		if (getErrnoCode$1(err) === "ENOENT") return 0;
		throw err;
	}
	let count = 0;
	for (const entry of entries) if (entry.endsWith(".json") || entry.endsWith(".tmp") || entry.endsWith(".delivered")) count += 1;
	return count;
}
async function enqueueSessionDelivery(params, stateDir, opts) {
	const queueDir = await ensureSessionDeliveryQueueDir(stateDir);
	const id = buildEntryId(params.idempotencyKey);
	const filePath = path.join(queueDir, `${id}.json`);
	if (params.idempotencyKey) try {
		if ((await fs.promises.stat(filePath)).isFile()) return id;
	} catch (err) {
		if (getErrnoCode$1(err) !== "ENOENT") throw err;
	}
	const maxQueuedFiles = opts?.maxQueuedFiles ?? 1e4;
	if (Number.isFinite(maxQueuedFiles) && maxQueuedFiles > 0) {
		const count = await countQueuedFiles(queueDir);
		if (count >= maxQueuedFiles) {
			console.warn(`[session-delivery-queue] enqueue rejected: ${count} queued files at top level, soft-cap is ${maxQueuedFiles}`);
			throw new SessionDeliveryQueueOverflowError(count, maxQueuedFiles);
		}
	}
	await writeQueueEntry(filePath, {
		...params,
		id,
		enqueuedAt: Date.now(),
		retryCount: 0
	});
	return id;
}
async function enqueuePostCompactionDelegateDelivery(params, stateDir, opts) {
	return await enqueueSessionDelivery(buildPostCompactionDelegateDeliveryPayload(params), stateDir, opts);
}
async function ackSessionDelivery(id, stateDir) {
	const { jsonPath, deliveredPath } = resolveQueueEntryPaths(id, stateDir);
	try {
		await fs.promises.rename(jsonPath, deliveredPath);
	} catch (err) {
		if (getErrnoCode$1(err) === "ENOENT") {
			await unlinkBestEffort(deliveredPath);
			return;
		}
		throw err;
	}
	await unlinkBestEffort(deliveredPath);
}
async function failSessionDelivery(id, error, stateDir) {
	const filePath = path.join(resolveSessionDeliveryQueueDir(stateDir), `${id}.json`);
	const entry = await readQueueEntry(filePath);
	entry.retryCount += 1;
	entry.lastAttemptAt = Date.now();
	entry.lastError = error;
	await writeQueueEntry(filePath, entry);
}
async function loadPendingSessionDelivery(id, stateDir) {
	const { jsonPath } = resolveQueueEntryPaths(id, stateDir);
	try {
		if (!(await fs.promises.stat(jsonPath)).isFile()) return null;
		return await readQueueEntry(jsonPath);
	} catch (err) {
		if (getErrnoCode$1(err) === "ENOENT") return null;
		throw err;
	}
}
async function loadPendingSessionDeliveries(stateDir) {
	const queueDir = resolveSessionDeliveryQueueDir(stateDir);
	let files;
	try {
		files = await fs.promises.readdir(queueDir);
	} catch (err) {
		if (getErrnoCode$1(err) === "ENOENT") return [];
		throw err;
	}
	const now = Date.now();
	for (const file of files) if (file.endsWith(".delivered")) await unlinkBestEffort(path.join(queueDir, file));
	else if (file.endsWith(".tmp")) await unlinkStaleTmpBestEffort(path.join(queueDir, file), now);
	const entries = [];
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		const filePath = path.join(queueDir, file);
		try {
			if (!(await fs.promises.stat(filePath)).isFile()) continue;
			entries.push(await readQueueEntry(filePath));
		} catch {
			continue;
		}
	}
	return entries;
}
async function moveSessionDeliveryToFailed(id, stateDir) {
	const queueDir = resolveSessionDeliveryQueueDir(stateDir);
	const failedDir = resolveFailedDir(stateDir);
	await fs.promises.mkdir(failedDir, {
		recursive: true,
		mode: 448
	});
	await fs.promises.rename(path.join(queueDir, `${id}.json`), path.join(failedDir, `${id}.json`));
}
async function pruneFailedOlderThan(maxAgeMs, now, stateDir) {
	const failedDir = resolveFailedDir(stateDir);
	let entries;
	try {
		entries = await fs.promises.readdir(failedDir);
	} catch (err) {
		if (getErrnoCode$1(err) === "ENOENT") return {
			scanned: 0,
			removed: 0
		};
		throw err;
	}
	let scanned = 0;
	let removed = 0;
	for (const entry of entries) {
		const filePath = path.join(failedDir, entry);
		try {
			const stat = await fs.promises.stat(filePath);
			if (!stat.isFile()) continue;
			scanned += 1;
			if (now - stat.mtimeMs > maxAgeMs) try {
				await fs.promises.unlink(filePath);
				removed += 1;
			} catch (unlinkErr) {
				if (getErrnoCode$1(unlinkErr) !== "ENOENT") throw unlinkErr;
			}
		} catch (err) {
			if (getErrnoCode$1(err) === "ENOENT") continue;
			throw err;
		}
	}
	return {
		scanned,
		removed
	};
}
//#endregion
//#region src/infra/session-delivery-queue-recovery.ts
const FAILED_GC_AMORTIZATION_MS = 6e4;
let lastGcAt = 0;
async function maybePruneFailedRecords(opts) {
	const { failedMaxAgeMs, stateDir, log, now } = opts;
	if (failedMaxAgeMs == null || !(failedMaxAgeMs > 0)) return;
	if (now - lastGcAt < FAILED_GC_AMORTIZATION_MS) return;
	try {
		const summary = await pruneFailedOlderThan(failedMaxAgeMs, now, stateDir);
		if (summary.removed > 0) log.info(`Session delivery failed/ prune: removed ${summary.removed} of ${summary.scanned} entries older than ${failedMaxAgeMs}ms`);
	} catch (err) {
		log.warn(`Session delivery failed/ prune error: ${formatErrorMessage$1(err)}`);
	} finally {
		lastGcAt = now;
	}
}
const BACKOFF_MS = [
	5e3,
	25e3,
	12e4,
	6e5
];
const drainInProgress = /* @__PURE__ */ new Map();
const entriesInProgress = /* @__PURE__ */ new Set();
function getErrnoCode(err) {
	return err && typeof err === "object" && "code" in err ? String(err.code) : null;
}
function createEmptyRecoverySummary() {
	return {
		recovered: 0,
		failed: 0,
		skippedMaxRetries: 0,
		deferredBackoff: 0
	};
}
function formatRetryBudgetExhaustedLog(entry) {
	if (entry.kind !== "postCompactionDelegate") return null;
	return `[session-delivery-queue:retry-budget-exhausted] entry ${entry.id} hit retry cap before post-compaction delegate spawn for session ${entry.sessionKey}: ${entry.task}`;
}
function logRetryBudgetExhausted(log, entry) {
	const message = formatRetryBudgetExhaustedLog(entry);
	if (message) log.warn(message);
}
function claimRecoveryEntry(entryId) {
	if (entriesInProgress.has(entryId)) return false;
	entriesInProgress.add(entryId);
	return true;
}
function releaseRecoveryEntry(entryId) {
	entriesInProgress.delete(entryId);
}
function computeSessionDeliveryBackoffMs(retryCount) {
	if (retryCount <= 0) return 0;
	return BACKOFF_MS[Math.min(retryCount - 1, BACKOFF_MS.length - 1)] ?? BACKOFF_MS.at(-1) ?? 0;
}
function isSessionDeliveryEligibleForRetry(entry, now) {
	const backoff = computeSessionDeliveryBackoffMs(entry.retryCount);
	if (backoff <= 0) return { eligible: true };
	if (entry.retryCount === 0 && entry.lastAttemptAt === void 0) return { eligible: true };
	const nextEligibleAt = (typeof entry.lastAttemptAt === "number" && entry.lastAttemptAt > 0 ? entry.lastAttemptAt : entry.enqueuedAt) + backoff;
	if (now >= nextEligibleAt) return { eligible: true };
	return {
		eligible: false,
		remainingBackoffMs: nextEligibleAt - now
	};
}
async function drainQueuedEntry(opts) {
	const { entry } = opts;
	try {
		await opts.deliver(entry);
		await ackSessionDelivery(entry.id, opts.stateDir);
		opts.onRecovered?.(entry);
		return "recovered";
	} catch (err) {
		const errMsg = formatErrorMessage$1(err);
		opts.onFailed?.(entry, errMsg);
		try {
			await failSessionDelivery(entry.id, errMsg, opts.stateDir);
			return "failed";
		} catch (failErr) {
			if (getErrnoCode(failErr) === "ENOENT") return "already-gone";
			return "failed";
		}
	}
}
async function drainPendingSessionDeliveries(opts) {
	if (drainInProgress.get(opts.drainKey)) {
		opts.log.info(`${opts.logLabel}: already in progress for ${opts.drainKey}, skipping`);
		return;
	}
	drainInProgress.set(opts.drainKey, true);
	try {
		await maybePruneFailedRecords({
			failedMaxAgeMs: opts.failedMaxAgeMs,
			stateDir: opts.stateDir,
			log: opts.log,
			now: Date.now()
		});
		const matchingEntries = (await loadPendingSessionDeliveries(opts.stateDir)).filter((entry) => opts.selectEntry(entry, Date.now()).match).toSorted((a, b) => a.enqueuedAt - b.enqueuedAt);
		for (const entry of matchingEntries) {
			if (!claimRecoveryEntry(entry.id)) {
				opts.log.info(`${opts.logLabel}: entry ${entry.id} is already being recovered`);
				continue;
			}
			try {
				const currentEntry = await loadPendingSessionDelivery(entry.id, opts.stateDir);
				if (!currentEntry) continue;
				const currentDecision = opts.selectEntry(currentEntry, Date.now());
				if (!currentDecision.match) continue;
				if (currentEntry.retryCount >= 5) {
					logRetryBudgetExhausted(opts.log, currentEntry);
					try {
						await moveSessionDeliveryToFailed(currentEntry.id, opts.stateDir);
					} catch (err) {
						if (getErrnoCode(err) !== "ENOENT") throw err;
					}
					opts.log.warn(`${opts.logLabel}: entry ${currentEntry.id} exceeded max retries and was moved to failed/`);
					continue;
				}
				if (!currentDecision.bypassBackoff) {
					const retryEligibility = isSessionDeliveryEligibleForRetry(currentEntry, Date.now());
					if (!retryEligibility.eligible) {
						opts.log.info(`${opts.logLabel}: entry ${currentEntry.id} not ready for retry yet — backoff ${retryEligibility.remainingBackoffMs}ms remaining`);
						continue;
					}
				}
				await drainQueuedEntry({
					entry: currentEntry,
					deliver: opts.deliver,
					stateDir: opts.stateDir,
					onFailed: (failedEntry, errMsg) => {
						opts.log.warn(`${opts.logLabel}: retry failed for entry ${failedEntry.id}: ${errMsg}`);
					}
				});
			} finally {
				releaseRecoveryEntry(entry.id);
			}
		}
	} finally {
		drainInProgress.delete(opts.drainKey);
	}
}
async function recoverPendingSessionDeliveries(opts) {
	await maybePruneFailedRecords({
		failedMaxAgeMs: opts.failedMaxAgeMs,
		stateDir: opts.stateDir,
		log: opts.log,
		now: Date.now()
	});
	const pending = (await loadPendingSessionDeliveries(opts.stateDir)).filter((entry) => opts.maxEnqueuedAt == null || entry.enqueuedAt <= opts.maxEnqueuedAt);
	if (pending.length === 0) return createEmptyRecoverySummary();
	pending.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
	const summary = createEmptyRecoverySummary();
	const deadline = Date.now() + (opts.maxRecoveryMs ?? 6e4);
	for (const entry of pending) {
		if (Date.now() >= deadline) {
			opts.log.warn("Session delivery recovery time budget exceeded — remaining entries deferred");
			break;
		}
		if (!claimRecoveryEntry(entry.id)) continue;
		try {
			const currentEntry = await loadPendingSessionDelivery(entry.id, opts.stateDir);
			if (!currentEntry) continue;
			if (opts.maxEnqueuedAt != null && currentEntry.enqueuedAt > opts.maxEnqueuedAt) continue;
			if (currentEntry.retryCount >= 5) {
				summary.skippedMaxRetries += 1;
				logRetryBudgetExhausted(opts.log, currentEntry);
				try {
					await moveSessionDeliveryToFailed(currentEntry.id, opts.stateDir);
				} catch (err) {
					if (getErrnoCode(err) !== "ENOENT") throw err;
				}
				continue;
			}
			if (!isSessionDeliveryEligibleForRetry(currentEntry, Date.now()).eligible) {
				summary.deferredBackoff += 1;
				continue;
			}
			if (await drainQueuedEntry({
				entry: currentEntry,
				deliver: opts.deliver,
				stateDir: opts.stateDir,
				onRecovered: () => {
					summary.recovered += 1;
				},
				onFailed: (_failedEntry, errMsg) => {
					summary.failed += 1;
					opts.log.warn(`Session delivery retry failed: ${errMsg}`);
				}
			}) === "recovered") opts.log.info(`Recovered session delivery ${currentEntry.id}`);
		} finally {
			releaseRecoveryEntry(entry.id);
		}
	}
	return summary;
}
//#endregion
//#region src/auto-reply/reply/post-compaction-delegate-dispatch.ts
const defaultRecoveryLog = {
	info: (message) => defaultRuntime.log(message),
	warn: (message) => defaultRuntime.log(message),
	error: (message) => defaultRuntime.log(message)
};
const defaultPostCompactionDelegateDeliveryDeps = {
	enqueueSystemEvent,
	getRuntimeConfig,
	loadSessionStore,
	log: (message) => defaultRuntime.log(message),
	now: () => Date.now(),
	resolveContinuationRuntimeConfig,
	resolveSessionAgentId,
	resolveStorePath,
	spawnSubagentDirect
};
const defaultPostCompactionDelegateDispatchDeps = {
	consumeStagedPostCompactionDelegates,
	drainPostCompactionDelegateDeliveries,
	enqueuePostCompactionDelegateDelivery,
	enqueueSystemEvent,
	log: (message) => defaultRuntime.log(message),
	now: () => Date.now(),
	readPostCompactionContext,
	resolveAgentWorkspaceDir,
	resolveContinuationRuntimeConfig,
	resolveSessionAgentId
};
const POST_COMPACTION_DELEGATE_TTL_MS = 10080 * 60 * 1e3;
function formatErrorMessage(err) {
	return err instanceof Error ? err.message : String(err);
}
function enqueueSystemEventOrLog(params) {
	try {
		params.deps.enqueueSystemEvent(params.text, { sessionKey: params.sessionKey });
	} catch (err) {
		params.deps.log(`Failed to enqueue ${params.label} for ${params.sessionKey}: ${formatErrorMessage(err)}`);
	}
}
function syncPendingPostCompactionDelegates(params) {
	if (params.sessionEntry) params.sessionEntry.pendingPostCompactionDelegates = params.delegates;
	if (params.sessionStore?.[params.sessionKey]) params.sessionStore[params.sessionKey] = {
		...params.sessionStore[params.sessionKey],
		pendingPostCompactionDelegates: params.delegates
	};
}
function normalizePostCompactionDelegate(delegate) {
	const legacySilentWake = delegate.silent == null && delegate.silentWake == null;
	const silentWake = legacySilentWake ? true : delegate.silentWake === true;
	const silent = legacySilentWake ? true : delegate.silent === true || silentWake;
	const firstArmedAt = delegate.firstArmedAt ?? delegate.createdAt;
	return {
		task: delegate.task,
		createdAt: delegate.createdAt,
		firstArmedAt,
		...delegate.silent != null || legacySilentWake ? { silent } : {},
		...delegate.silentWake != null || legacySilentWake ? { silentWake } : {}
	};
}
function formatTaskPreview(task) {
	return JSON.stringify(task.length > 120 ? `${task.slice(0, 117)}...` : task);
}
async function persistPendingPostCompactionDelegates(params) {
	if (params.delegates.length === 0) return (params.sessionEntry?.pendingPostCompactionDelegates ?? []).map(normalizePostCompactionDelegate);
	const normalizedDelegates = params.delegates.map(normalizePostCompactionDelegate);
	const combinedLocal = [...(params.sessionEntry?.pendingPostCompactionDelegates ?? []).map(normalizePostCompactionDelegate), ...normalizedDelegates];
	if (!params.storePath) {
		syncPendingPostCompactionDelegates({
			sessionEntry: params.sessionEntry,
			sessionStore: params.sessionStore,
			sessionKey: params.sessionKey,
			delegates: combinedLocal
		});
		return combinedLocal;
	}
	const persisted = await updateSessionStore(params.storePath, (store) => {
		const resolved = resolveSessionStoreEntry({
			store,
			sessionKey: params.sessionKey
		});
		const current = resolved.existing ?? params.sessionStore?.[params.sessionKey] ?? params.sessionEntry ?? void 0;
		const combined = [...(current?.pendingPostCompactionDelegates ?? []).map(normalizePostCompactionDelegate), ...normalizedDelegates];
		if (current) {
			store[resolved.normalizedKey] = {
				...current,
				pendingPostCompactionDelegates: combined
			};
			for (const legacyKey of resolved.legacyKeys) delete store[legacyKey];
		}
		return combined;
	});
	syncPendingPostCompactionDelegates({
		sessionEntry: params.sessionEntry,
		sessionStore: params.sessionStore,
		sessionKey: params.sessionKey,
		delegates: persisted.length > 0 ? persisted : combinedLocal
	});
	return persisted.length > 0 ? persisted : combinedLocal;
}
async function takePendingPostCompactionDelegates(params) {
	const localDelegates = (params.sessionEntry?.pendingPostCompactionDelegates ?? []).map(normalizePostCompactionDelegate);
	if (!params.storePath) {
		syncPendingPostCompactionDelegates({
			sessionEntry: params.sessionEntry,
			sessionStore: params.sessionStore,
			sessionKey: params.sessionKey,
			delegates: void 0
		});
		return localDelegates;
	}
	const persisted = await updateSessionStore(params.storePath, (store) => {
		const resolved = resolveSessionStoreEntry({
			store,
			sessionKey: params.sessionKey
		});
		const current = resolved.existing ?? params.sessionStore?.[params.sessionKey] ?? params.sessionEntry ?? void 0;
		const delegates = (current?.pendingPostCompactionDelegates ?? []).map(normalizePostCompactionDelegate);
		if (current && delegates.length > 0) {
			store[resolved.normalizedKey] = {
				...current,
				pendingPostCompactionDelegates: void 0
			};
			for (const legacyKey of resolved.legacyKeys) delete store[legacyKey];
		}
		return delegates;
	});
	syncPendingPostCompactionDelegates({
		sessionEntry: params.sessionEntry,
		sessionStore: params.sessionStore,
		sessionKey: params.sessionKey,
		delegates: void 0
	});
	return persisted.length > 0 ? persisted : localDelegates;
}
function buildPostCompactionLifecycleEvent(params) {
	return [
		`[system:post-compaction] Session compacted at ${(/* @__PURE__ */ new Date()).toISOString()}.`,
		typeof params.compactionCount === "number" ? `Compaction count: ${params.compactionCount}.` : void 0,
		`Queued ${params.queuedDelegates} post-compaction delegate(s) for delivery into the fresh session.`,
		params.droppedDelegates > 0 ? `${params.droppedDelegates} delegate(s) were not released into the fresh session.` : void 0
	].filter(Boolean).join(" ");
}
async function persistPostCompactionDelegateChainState(params) {
	const chainId = params.sessionEntry?.continuationChainId ?? generateChainId();
	if (params.sessionEntry) {
		params.sessionEntry.continuationChainCount = params.count;
		params.sessionEntry.continuationChainStartedAt = params.startedAt;
		params.sessionEntry.continuationChainTokens = params.tokens;
		params.sessionEntry.continuationChainId = chainId;
	}
	if (params.sessionStore) {
		const resolved = resolveSessionStoreEntry({
			store: params.sessionStore,
			sessionKey: params.sessionKey
		});
		const existingEntry = resolved.existing ?? params.sessionStore[params.sessionKey] ?? params.sessionEntry;
		if (existingEntry) {
			params.sessionStore[resolved.normalizedKey] = {
				...existingEntry,
				continuationChainCount: params.count,
				continuationChainStartedAt: params.startedAt,
				continuationChainTokens: params.tokens,
				continuationChainId: chainId
			};
			for (const legacyKey of resolved.legacyKeys) delete params.sessionStore[legacyKey];
		}
	}
	if (params.storePath) try {
		await updateSessionStore(params.storePath, (store) => {
			const resolved = resolveSessionStoreEntry({
				store,
				sessionKey: params.sessionKey
			});
			const existingEntry = resolved.existing ?? store[params.sessionKey];
			if (existingEntry) {
				store[resolved.existing ? resolved.normalizedKey : params.sessionKey] = {
					...existingEntry,
					continuationChainCount: params.count,
					continuationChainStartedAt: params.startedAt,
					continuationChainTokens: params.tokens,
					continuationChainId: chainId
				};
				if (resolved.existing) for (const legacyKey of resolved.legacyKeys) delete store[legacyKey];
			}
		});
	} catch (err) {
		params.log(`Failed to persist post-compaction delegate chain state for ${params.sessionKey}: ${String(err)}`);
		throw err;
	}
}
function resolvePostCompactionDeliveryContext(followupRun) {
	const deliveryContext = {
		...followupRun.originatingChannel ? { channel: followupRun.originatingChannel } : {},
		...followupRun.originatingTo ? { to: followupRun.originatingTo } : {},
		...followupRun.originatingAccountId ? { accountId: followupRun.originatingAccountId } : {},
		...followupRun.originatingThreadId != null ? { threadId: followupRun.originatingThreadId } : {}
	};
	return Object.keys(deliveryContext).length > 0 ? deliveryContext : void 0;
}
function isPostCompactionDelegateEntry(entry) {
	return entry.kind === "postCompactionDelegate";
}
async function deliverQueuedPostCompactionDelegate(params, deps = defaultPostCompactionDelegateDeliveryDeps) {
	const cfg = deps.getRuntimeConfig();
	const agentId = deps.resolveSessionAgentId({
		sessionKey: params.entry.sessionKey,
		config: cfg
	});
	const storePath = deps.resolveStorePath(cfg.session?.store, { agentId });
	const sessionStore = deps.loadSessionStore(storePath);
	const sessionEntry = resolveSessionStoreEntry({
		store: sessionStore,
		sessionKey: params.entry.sessionKey
	}).existing ?? sessionStore[params.entry.sessionKey];
	const { maxChainLength: maxCompactionChainLength, costCapTokens: compactionCostCapTokens } = deps.resolveContinuationRuntimeConfig(cfg);
	const currentCompactionChainCount = sessionEntry?.continuationChainCount ?? 0;
	const compactionChainTokens = sessionEntry?.continuationChainTokens ?? 0;
	if (currentCompactionChainCount >= maxCompactionChainLength) {
		deps.log(`Post-compaction delegate rejected: chain length ${currentCompactionChainCount} >= ${maxCompactionChainLength} for session ${params.entry.sessionKey}`);
		deps.enqueueSystemEvent(`[continuation] Post-compaction delegate rejected: chain length ${maxCompactionChainLength} reached. Task: ${params.entry.task}`, { sessionKey: params.entry.sessionKey });
		return;
	}
	if (compactionCostCapTokens > 0 && compactionChainTokens > compactionCostCapTokens) {
		deps.log(`Post-compaction delegate rejected: cost cap exceeded (${compactionChainTokens} > ${compactionCostCapTokens}) for session ${params.entry.sessionKey}`);
		deps.enqueueSystemEvent(`[continuation] Post-compaction delegate rejected: cost cap exceeded (${compactionChainTokens} > ${compactionCostCapTokens}). Task: ${params.entry.task}`, { sessionKey: params.entry.sessionKey });
		return;
	}
	const nextCompactionChainCount = currentCompactionChainCount + 1;
	deps.log(`Post-compaction delegate dispatch for session ${params.entry.sessionKey}: ${params.entry.task}`);
	const delegateWakeOnReturn = params.entry.silentWake ?? true;
	const delegateSilentAnnounce = params.entry.silent ?? delegateWakeOnReturn;
	const spawnResult = await deps.spawnSubagentDirect({
		task: `[continuation:post-compaction] [continuation:chain-hop:${nextCompactionChainCount}] Compaction just completed. Carry this working state to the post-compaction session: ${params.entry.task}`,
		...delegateSilentAnnounce ? { silentAnnounce: true } : {},
		...delegateWakeOnReturn ? {
			silentAnnounce: true,
			wakeOnReturn: true
		} : {},
		drainsContinuationDelegateQueue: true
	}, {
		agentSessionKey: params.entry.sessionKey,
		agentChannel: params.entry.deliveryContext?.channel,
		agentAccountId: params.entry.deliveryContext?.accountId,
		agentTo: params.entry.deliveryContext?.to,
		agentThreadId: params.entry.deliveryContext?.threadId
	});
	if (spawnResult.status !== "accepted") throw new Error(`post-compaction delegate spawn ${spawnResult.status}`);
	deps.enqueueSystemEvent(`[continuation:compaction-delegate-spawned] Post-compaction shard dispatched: ${params.entry.task}`, { sessionKey: params.entry.sessionKey });
	await persistPostCompactionDelegateChainState({
		count: nextCompactionChainCount,
		log: (message) => deps.log(message),
		sessionEntry,
		sessionKey: params.entry.sessionKey,
		sessionStore,
		startedAt: sessionEntry?.continuationChainStartedAt ?? deps.now(),
		storePath,
		tokens: compactionChainTokens
	});
}
async function drainPostCompactionDelegateDeliveries(params) {
	const entryIds = new Set(params.entryIds ?? []);
	await drainPendingSessionDeliveries({
		drainKey: `post-compaction-delegate:${params.sessionKey ?? "all"}`,
		logLabel: "post-compaction delegate",
		log: params.log ?? defaultRecoveryLog,
		stateDir: params.stateDir,
		deliver: async (entry) => {
			if (!isPostCompactionDelegateEntry(entry)) return;
			await deliverQueuedPostCompactionDelegate({ entry }, params.deliveryDeps);
		},
		selectEntry: (entry) => ({
			match: isPostCompactionDelegateEntry(entry) && (params.sessionKey == null || entry.sessionKey === params.sessionKey) && (entryIds.size === 0 || entryIds.has(entry.id)),
			bypassBackoff: entryIds.size > 0
		})
	});
}
async function dispatchPostCompactionDelegates(params, deps = defaultPostCompactionDelegateDispatchDeps) {
	const stagedCompactionDelegates = deps.consumeStagedPostCompactionDelegates(params.sessionKey);
	let persistedCompactionDelegates = [];
	try {
		persistedCompactionDelegates = await takePendingPostCompactionDelegates({
			sessionEntry: params.sessionEntry,
			sessionStore: params.sessionStore,
			sessionKey: params.sessionKey,
			storePath: params.storePath
		});
	} catch (err) {
		const message = formatErrorMessage(err);
		deps.log(`Failed to load post-compaction delegates for ${params.sessionKey}: ${message}`);
		enqueueSystemEventOrLog({
			deps,
			label: "persisted post-compaction delegate warning",
			sessionKey: params.sessionKey,
			text: `[system:continuation-warning] Failed to load persisted post-compaction delegates for this session: ${message}. Earlier turns may have staged delegates that will not fire. Re-stage critical post-compaction work.`
		});
	}
	const allCompactionDelegates = [...persistedCompactionDelegates, ...stagedCompactionDelegates].map(normalizePostCompactionDelegate);
	const now = deps.now();
	const freshCompactionDelegates = [];
	let staleDroppedDelegates = 0;
	for (const delegate of allCompactionDelegates) {
		const ageMs = now - (delegate.firstArmedAt ?? delegate.createdAt);
		if (ageMs > 6048e5) {
			staleDroppedDelegates += 1;
			deps.log(`Post-compaction delegate dropped as stale for ${params.sessionKey}: ageMs=${ageMs} ttlMs=${POST_COMPACTION_DELEGATE_TTL_MS} firstArmedAt=${delegate.firstArmedAt ?? delegate.createdAt} task=${formatTaskPreview(delegate.task)}`);
			continue;
		}
		freshCompactionDelegates.push(delegate);
	}
	const { maxDelegatesPerTurn: maxCompactionDelegates } = deps.resolveContinuationRuntimeConfig(params.cfg);
	const bracketDelegateOffset = params.continuationSignalKind === "delegate" ? 1 : 0;
	const compactionBudget = Math.max(0, maxCompactionDelegates - bracketDelegateOffset);
	const releasedCompactionDelegates = freshCompactionDelegates.slice(0, compactionBudget);
	const overflowDroppedDelegates = Math.max(0, freshCompactionDelegates.length - releasedCompactionDelegates.length);
	if (overflowDroppedDelegates > 0) deps.log(`Post-compaction delegates dropped for ${params.sessionKey}: ${overflowDroppedDelegates} over maxDelegatesPerTurn budget (${maxCompactionDelegates}, bracketOffset=${bracketDelegateOffset})`);
	deps.readPostCompactionContext(typeof params.followupRun.run.workspaceDir === "string" && params.followupRun.run.workspaceDir.trim() ? params.followupRun.run.workspaceDir : deps.resolveAgentWorkspaceDir(params.cfg, params.followupRun.run.agentId), {
		cfg: params.cfg,
		agentId: deps.resolveSessionAgentId({
			sessionKey: params.sessionKey,
			config: params.cfg
		})
	}).then((contextContent) => {
		if (contextContent) deps.enqueueSystemEvent(contextContent, { sessionKey: params.sessionKey });
	}).catch((err) => {
		const message = formatErrorMessage(err);
		deps.log(`[continuation:post-compaction-context-read-failed] sessionKey=${params.sessionKey} error=${message}`);
		enqueueSystemEventOrLog({
			deps,
			label: "post-compaction context read failure",
			sessionKey: params.sessionKey,
			text: `[system:post-compaction] Context evacuation read failed: ${message}. The post-compaction session may be missing AGENTS.md/RESUMPTION.md content. Check workspace permissions and re-run if needed.`
		});
	});
	const deliveryContext = resolvePostCompactionDeliveryContext(params.followupRun);
	const enqueueResults = await Promise.allSettled(releasedCompactionDelegates.map((delegate, sequence) => deps.enqueuePostCompactionDelegateDelivery({
		sessionKey: params.sessionKey,
		delegate,
		sequence,
		compactionCount: params.compactionCount,
		...deliveryContext ? { deliveryContext } : {}
	})));
	const queuedEntryIds = [];
	let droppedCompactionDelegates = staleDroppedDelegates + overflowDroppedDelegates;
	for (const [index, result] of enqueueResults.entries()) {
		if (result.status === "fulfilled") {
			queuedEntryIds.push(result.value);
			continue;
		}
		droppedCompactionDelegates += 1;
		const delegate = releasedCompactionDelegates[index];
		if (delegate) params.postCompactionDelegatesToPreserve.push(delegate);
		deps.log(`Failed to enqueue post-compaction delegate for ${params.sessionKey} (re-staged): ${String(result.reason)}`);
	}
	if (params.postCompactionDelegatesToPreserve.length > 0) try {
		await persistPendingPostCompactionDelegates({
			sessionEntry: params.sessionEntry,
			sessionStore: params.sessionStore,
			sessionKey: params.sessionKey,
			storePath: params.storePath,
			delegates: params.postCompactionDelegatesToPreserve
		});
		params.postCompactionDelegatesToPreserve.length = 0;
	} catch (err) {
		deps.log(`Failed to persist re-staged post-compaction delegates for ${params.sessionKey} (${params.postCompactionDelegatesToPreserve.length}): ${String(err)}`);
	}
	deps.enqueueSystemEvent(buildPostCompactionLifecycleEvent({
		compactionCount: params.compactionCount,
		queuedDelegates: queuedEntryIds.length,
		droppedDelegates: droppedCompactionDelegates
	}), { sessionKey: params.sessionKey });
	if (queuedEntryIds.length > 0) deps.drainPostCompactionDelegateDeliveries({
		log: defaultRecoveryLog,
		sessionKey: params.sessionKey
	}).catch((err) => {
		deps.log(`Failed to drain queued post-compaction delegates for ${params.sessionKey}: ${String(err)}`);
	});
	return {
		queuedDelegates: queuedEntryIds.length,
		droppedDelegates: droppedCompactionDelegates
	};
}
//#endregion
export { recoverPendingSessionDeliveries as a, drainPendingSessionDeliveries as i, dispatchPostCompactionDelegates as n, enqueueSessionDelivery as o, persistPendingPostCompactionDelegates as r, deliverQueuedPostCompactionDelegate as t };
