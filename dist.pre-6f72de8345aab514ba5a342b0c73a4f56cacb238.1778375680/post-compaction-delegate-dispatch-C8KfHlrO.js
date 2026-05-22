import { i as formatErrorMessage$1 } from "./errors-D0hgXIu9.js";
import { o as resolveAgentWorkspaceDir } from "./agent-scope-config-BUbm4C3v.js";
import { p as resolveSessionAgentId } from "./agent-scope-CcthxFej.js";
import { n as defaultRuntime } from "./runtime-Vyd5gFd2.js";
import { i as getRuntimeConfig } from "./io-CwtTPcP9.js";
import "./config-OQqPmWUa.js";
import { u as resolveStorePath } from "./paths-BYkpLqJF.js";
import { t as loadSessionStore } from "./store-load-CR507N_-.js";
import { f as resolveSessionStoreEntry, s as updateSessionStore } from "./store-bHMyvLAj.js";
import { n as spawnSubagentDirect } from "./subagent-spawn-nS_WHCls.js";
import { j as readPostCompactionContext } from "./compaction-successor-transcript-BFmGfuzA.js";
import { t as resolveContinuationRuntimeConfig } from "./config-CeeZL2OF.js";
import { t as generateChainId } from "./secure-random-CWAlPln7.js";
import { c as loadPendingSessionDelivery, i as enqueuePostCompactionDelegateDelivery, l as moveSessionDeliveryToFailed, o as failSessionDelivery, r as ackSessionDelivery, s as loadPendingSessionDeliveries, u as pruneFailedOlderThan } from "./targeting-CgdebXg-.js";
import { a as enqueueSystemEvent } from "./system-events-DLH2vbkB.js";
import { t as consumeStagedPostCompactionDelegates } from "./continuation-delegate-store-DgLXk5Q-.js";
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
				if (currentEntry.retryCount >= (currentEntry.maxRetries ?? 5)) {
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
			if (currentEntry.retryCount >= (currentEntry.maxRetries ?? 5)) {
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
		...delegate.silentWake != null || legacySilentWake ? { silentWake } : {},
		...delegate.targetSessionKey ? { targetSessionKey: delegate.targetSessionKey } : {},
		...delegate.targetSessionKeys && delegate.targetSessionKeys.length > 0 ? { targetSessionKeys: delegate.targetSessionKeys } : {},
		...delegate.fanoutMode ? { fanoutMode: delegate.fanoutMode } : {},
		...delegate.traceparent ? { traceparent: delegate.traceparent } : {}
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
		deps.enqueueSystemEvent(`[continuation] Post-compaction delegate rejected: chain length ${maxCompactionChainLength} reached. Task: ${params.entry.task}`, {
			sessionKey: params.entry.sessionKey,
			...params.entry.traceparent ? { traceparent: params.entry.traceparent } : {}
		});
		return;
	}
	if (compactionCostCapTokens > 0 && compactionChainTokens > compactionCostCapTokens) {
		deps.log(`Post-compaction delegate rejected: cost cap exceeded (${compactionChainTokens} > ${compactionCostCapTokens}) for session ${params.entry.sessionKey}`);
		deps.enqueueSystemEvent(`[continuation] Post-compaction delegate rejected: cost cap exceeded (${compactionChainTokens} > ${compactionCostCapTokens}). Task: ${params.entry.task}`, {
			sessionKey: params.entry.sessionKey,
			...params.entry.traceparent ? { traceparent: params.entry.traceparent } : {}
		});
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
		...params.entry.targetSessionKey ? { continuationTargetSessionKey: params.entry.targetSessionKey } : {},
		...params.entry.targetSessionKeys && params.entry.targetSessionKeys.length > 0 ? { continuationTargetSessionKeys: params.entry.targetSessionKeys } : {},
		...params.entry.fanoutMode ? { continuationFanoutMode: params.entry.fanoutMode } : {},
		drainsContinuationDelegateQueue: true,
		...params.entry.traceparent ? { traceparent: params.entry.traceparent } : {}
	}, {
		agentSessionKey: params.entry.sessionKey,
		agentChannel: params.entry.deliveryContext?.channel,
		agentAccountId: params.entry.deliveryContext?.accountId,
		agentTo: params.entry.deliveryContext?.to,
		agentThreadId: params.entry.deliveryContext?.threadId
	});
	if (spawnResult.status !== "accepted") throw new Error(`post-compaction delegate spawn ${spawnResult.status}`);
	deps.enqueueSystemEvent(`[continuation:compaction-delegate-spawned] Post-compaction shard dispatched: ${params.entry.task}`, {
		sessionKey: params.entry.sessionKey,
		...params.entry.traceparent ? { traceparent: params.entry.traceparent } : {}
	});
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
export { recoverPendingSessionDeliveries as a, drainPendingSessionDeliveries as i, dispatchPostCompactionDelegates as n, persistPendingPostCompactionDelegates as r, deliverQueuedPostCompactionDelegate as t };
