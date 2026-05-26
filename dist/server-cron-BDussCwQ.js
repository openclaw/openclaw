import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import "./agent-scope-CtLXGcWm.js";
import { a as isSubagentSessionKey, c as parseAgentSessionKey, r as isCronRunSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { d as resolveAgentIdFromSessionKey, f as resolveEventSessionKey, l as normalizeAgentId, v as toAgentStoreSessionKey } from "./session-key-Bte0mmcq.js";
import { c as resolveDefaultAgentId } from "./agent-scope-config-CMp71_27.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { r as getChildLogger } from "./logger-Dg9dVaLI.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { t as parseDurationMs } from "./parse-duration-CD4d_yk2.js";
import { t as getGlobalHookRunner } from "./hook-runner-global-BkXXy1ub.js";
import { n as resolveAgentMainSessionKey, t as canonicalizeMainSessionAlias } from "./main-session-D3q_5w0B.js";
import { n as deliveryContextFromSession } from "./delivery-context.shared-CBmB9dF7.js";
import { u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { i as readSessionEntry, t as loadSessionStore } from "./store-load-z4thf6ld.js";
import { t as archiveRemovedSessionTranscripts, u as updateSessionStore } from "./store-BmtchQvp.js";
import "./sessions-CQHHcgC_.js";
import "./logging-B2Kt4cNB.js";
import { a as isRetryableHeartbeatBusySkipReason, o as requestHeartbeat } from "./heartbeat-wake-BEc0M8hq.js";
import { a as enqueueSystemEvent } from "./system-events-11EG3LzK.js";
import { a as failTaskRunByRunId, i as createRunningTaskRun, n as completeTaskRunByRunId } from "./detached-task-runtime-C79km_82.js";
import { t as abortAndDrainEmbeddedPiRun } from "./runs-DrbsiywK.js";
import "./session-utils.fs-CsnHXIqH.js";
import { i as cleanupArchivedSessionTranscripts } from "./session-transcript-files.fs-CDIpA7EV.js";
import { i as enqueueCommandInLane } from "./command-queue-Da2Lh3Ua.js";
import { i as markCronJobActive, t as clearCronJobActive } from "./active-jobs-D4eKAY4b.js";
import { a as summarizeCronRunDiagnostics, i as normalizeCronRunDiagnostics, n as createCronRunDiagnosticsFromError } from "./run-diagnostics-BXtBy-0s.js";
import { a as resolveCronRunLogPath, o as resolveCronRunLogPruneOptions, t as appendCronRunLog } from "./run-log-Bi9tKROY.js";
import { a as cronSchedulingInputsEqual, i as saveCronStore, r as resolveCronStorePath, t as loadCronStore } from "./store-PoorarMW.js";
import { d as normalizeCronJobInput } from "./openclaw-tools-QeySpphx.js";
import { s as resolveFailoverReasonFromError } from "./failover-error-CZCIurQK.js";
import { r as resolveMainScopedEventSessionKey } from "./event-session-routing-SZ_PlpYU.js";
import { a as resolveCronDeliverySessionKey, o as resolveCronNotificationSessionKey, r as isInvalidCronSessionTargetIdError, s as resolveCronSessionTargetSessionKey, t as normalizeHttpWebhookUrl } from "./webhook-url-CYBYCR4B.js";
import { n as normalizeOptionalAgentId } from "./normalize-CV8XB8wE.js";
import { t as SsrFBlockedError } from "./ssrf-DdDeGa5L.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import { t as buildOutboundSessionContext } from "./session-context-DSIPIqLK.js";
import { t as sendDurableMessageBatch } from "./send-CGvo7HYh.js";
import "./runtime-BN74dT7u.js";
import "./pi-embedded-CsSFzly6.js";
import { n as resolveAgentOutboundIdentity } from "./identity-BGOlUGTo.js";
import { t as createOutboundSendDeps } from "./outbound-send-deps-fPP8XU6h.js";
import { t as cleanupBrowserSessionsForLifecycleEnd } from "./browser-lifecycle-cleanup-2wAktWEk.js";
import { t as getInvalidPersistedCronJobReason } from "./persisted-shape-DyK3Ydhz.js";
import { t as runCronIsolatedAgentTurn } from "./isolated-agent-MnMFQtQj.js";
import { n as resolveFailureDestination, t as resolveCronDeliveryPlan } from "./delivery-plan-DRpBOJ2V.js";
import { t as resolveCronAgentSessionKey } from "./session-key-D_ijetg2.js";
import { _ as resolveDeliveryTarget, a as computeJobPreviousRunAtMs, c as findJobOrThrow, d as isJobEnabled, f as nextWakeAtMs, g as resolveJobPayloadTextForMain, h as recordScheduleComputeError, i as computeJobNextRunAtMs, l as hasScheduledNextRunAtMs, m as recomputeNextRunsForMaintenance, n as applyJobPatch, o as createJob, p as recomputeNextRuns, r as assertSupportedJobSpec, s as errorBackoffMs, t as DEFAULT_ERROR_BACKOFF_SCHEDULE_MS, u as isJobDue } from "./jobs-CYMnCvkL.js";
import { t as createCronExecutionId } from "./run-id-BEdij8BZ.js";
import { n as runHeartbeatOnce } from "./heartbeat-runner-DDFMtPQL.js";
import fs from "node:fs";
//#region src/cron/service/locked.ts
const storeLocks = /* @__PURE__ */ new Map();
const resolveChain = (promise) => promise.then(() => void 0, () => void 0);
async function locked(state, fn) {
	const storePath = state.deps.storePath;
	const storeOp = storeLocks.get(storePath) ?? Promise.resolve();
	const next = Promise.all([resolveChain(state.op), resolveChain(storeOp)]).then(fn);
	const keepAlive = resolveChain(next);
	state.op = keepAlive;
	storeLocks.set(storePath, keepAlive);
	return await next;
}
//#endregion
//#region src/cron/normalize-job-identity.ts
function normalizeCronJobIdentityFields(raw) {
	const rawId = normalizeOptionalString(raw.id) ?? "";
	const legacyJobId = normalizeOptionalString(raw.jobId) ?? "";
	const hadJobIdKey = "jobId" in raw;
	const normalizedId = rawId || legacyJobId;
	const idChanged = Boolean(normalizedId && raw.id !== normalizedId);
	if (idChanged) raw.id = normalizedId;
	if (hadJobIdKey) delete raw.jobId;
	return {
		mutated: idChanged || hadJobIdKey,
		legacyJobIdIssue: hadJobIdKey
	};
}
//#endregion
//#region src/cron/service/store.ts
function invalidateStaleNextRunOnScheduleChange(params) {
	const previousJob = params.previousJobsById.get(params.hydrated.id);
	if (!previousJob || cronSchedulingInputsEqual(previousJob, params.hydrated)) return;
	params.hydrated.state ??= {};
	params.hydrated.state.nextRunAtMs = void 0;
}
function warnInvalidPersistedCronJob(params) {
	const jobId = typeof params.raw.id === "string" ? params.raw.id : void 0;
	const dedupeKey = jobId ?? `index:${params.index}`;
	if (params.state.warnedInvalidPersistedJobKeys.has(dedupeKey)) return;
	params.state.warnedInvalidPersistedJobKeys.add(dedupeKey);
	params.state.deps.log.warn({
		storePath: params.state.deps.storePath,
		jobId,
		jobIndex: params.index,
		reason: params.reason
	}, "cron: skipped invalid persisted job; run openclaw doctor --fix to repair");
}
async function getFileMtimeMs(path) {
	try {
		return (await fs.promises.stat(path)).mtimeMs;
	} catch {
		return null;
	}
}
async function ensureLoaded(state, opts) {
	if (state.store && !opts?.forceReload) return;
	const previousJobsById = /* @__PURE__ */ new Map();
	for (const job of state.store?.jobs ?? []) previousJobsById.set(job.id, job);
	const fileMtimeMs = await getFileMtimeMs(state.deps.storePath);
	const loadedJobs = (await loadCronStore(state.deps.storePath)).jobs ?? [];
	const jobs = [];
	for (const [index, job] of loadedJobs.entries()) {
		const raw = job;
		const { legacyJobIdIssue } = normalizeCronJobIdentityFields(raw);
		let normalized;
		try {
			normalized = normalizeCronJobInput(raw);
		} catch (error) {
			if (!isInvalidCronSessionTargetIdError(error)) throw error;
			normalized = null;
			state.deps.log.warn({
				storePath: state.deps.storePath,
				jobId: typeof raw.id === "string" ? raw.id : void 0
			}, "cron: job has invalid persisted sessionTarget; run openclaw doctor --fix to repair");
		}
		const hydrated = normalized && typeof normalized === "object" ? normalized : job;
		const invalidReason = getInvalidPersistedCronJobReason(hydrated);
		if (invalidReason) {
			warnInvalidPersistedCronJob({
				state,
				raw,
				index,
				reason: invalidReason
			});
			continue;
		}
		jobs.push(hydrated);
		if (legacyJobIdIssue) {
			const resolvedId = typeof hydrated.id === "string" ? hydrated.id : void 0;
			state.deps.log.warn({
				storePath: state.deps.storePath,
				jobId: resolvedId
			}, "cron: job used legacy jobId field; normalized id in memory (run openclaw doctor --fix to persist canonical shape)");
		}
		if (typeof hydrated.enabled !== "boolean") hydrated.enabled = true;
		invalidateStaleNextRunOnScheduleChange({
			previousJobsById,
			hydrated
		});
		if (typeof hydrated.sessionTarget !== "string") {
			const payload = hydrated.payload;
			const payloadKind = payload && typeof payload === "object" && !Array.isArray(payload) && Object.hasOwn(payload, "kind") ? payload.kind : void 0;
			let defaulted;
			if (payloadKind === "systemEvent") defaulted = "main";
			else if (payloadKind === "agentTurn") defaulted = "isolated";
			if (defaulted) {
				hydrated.sessionTarget = defaulted;
				const jobId = typeof hydrated.id === "string" ? hydrated.id : void 0;
				const dedupeKey = jobId ?? "<unknown>";
				if (!state.warnedMissingSessionTargetJobIds.has(dedupeKey)) {
					state.warnedMissingSessionTargetJobIds.add(dedupeKey);
					state.deps.log.warn({
						storePath: state.deps.storePath,
						jobId,
						defaulted
					}, "cron: job missing sessionTarget; defaulted in memory (edit jobs.json to persist canonical shape)");
				}
			}
		}
	}
	state.store = {
		version: 1,
		jobs
	};
	state.storeLoadedAtMs = state.deps.nowMs();
	state.storeFileMtimeMs = fileMtimeMs;
	if (!opts?.skipRecompute) recomputeNextRuns(state);
}
function warnIfDisabled(state, action) {
	if (state.deps.cronEnabled) return;
	if (state.warnedDisabled) return;
	state.warnedDisabled = true;
	state.deps.log.warn({
		enabled: false,
		action,
		storePath: state.deps.storePath
	}, "cron: scheduler disabled; jobs will not run automatically");
}
async function persist(state, opts) {
	if (!state.store) return;
	await saveCronStore(state.deps.storePath, state.store, opts);
	state.storeFileMtimeMs = await getFileMtimeMs(state.deps.storePath);
}
//#endregion
//#region src/agents/pi-embedded-runner/execution-phase.ts
const EMBEDDED_AGENT_EXECUTION_PHASE_LABELS = {
	runner_entered: "runner-entered",
	workspace: "workspace",
	runtime_plugins: "runtime-plugins",
	before_agent_reply: "before-agent-reply",
	model_resolution: "model-resolution",
	auth: "auth",
	context_engine: "context-engine",
	attempt_dispatch: "attempt-dispatch",
	context_assembled: "context-assembled",
	turn_accepted: "turn-accepted",
	process_spawned: "process-spawned",
	tool_execution_started: "tool-execution-started",
	assistant_output_started: "assistant-output-started",
	model_call_started: "model-call-started"
};
function formatEmbeddedAgentExecutionPhase(phase) {
	return phase ? EMBEDDED_AGENT_EXECUTION_PHASE_LABELS[phase] : void 0;
}
//#endregion
//#region src/cron/retry-hint.ts
const TRANSIENT_PATTERNS = {
	rate_limit: /(rate[_ ]limit|too many requests|429|resource has been exhausted|cloudflare|tokens per day)/i,
	overloaded: /\b529\b|\boverloaded(?:_error)?\b|high demand|temporar(?:ily|y) overloaded|capacity exceeded/i,
	network: /(network|fetch failed|socket|econnreset|econnrefused|eai_again|ehostunreach|ehostdown|enetreset|enetunreach|epipe)/i,
	timeout: /(timeout|etimedout)/i,
	server_error: /\b5\d{2}\b/
};
function resolveCronExecutionRetryHint(error, retryOn, classifiedReason) {
	if (!error || typeof error !== "string") return { retryable: false };
	const keys = retryOn?.length ? retryOn : Object.keys(TRANSIENT_PATTERNS);
	const classified = classifiedReason ?? void 0;
	if (classified && keys.includes(classified)) return {
		retryable: true,
		category: classified
	};
	for (const key of keys) if (TRANSIENT_PATTERNS[key]?.test(error)) return {
		retryable: true,
		category: key
	};
	return { retryable: false };
}
//#endregion
//#region src/cron/session-reaper.ts
/**
* Cron session reaper — prunes completed isolated cron run sessions
* from the session store after a configurable retention period.
*
* Pattern: sessions keyed as `...:cron:<jobId>:run:<uuid>` are ephemeral
* run records. The base session (`...:cron:<jobId>`) is kept as-is.
*/
const DEFAULT_RETENTION_MS = 24 * 36e5;
/** Minimum interval between reaper sweeps (avoid running every timer tick). */
const MIN_SWEEP_INTERVAL_MS = 5 * 6e4;
const lastSweepAtMsByStore = /* @__PURE__ */ new Map();
function resolveRetentionMs(cronConfig) {
	if (cronConfig?.sessionRetention === false) return null;
	const raw = cronConfig?.sessionRetention;
	if (typeof raw === "string" && raw.trim()) try {
		return parseDurationMs(raw.trim(), { defaultUnit: "h" });
	} catch {
		return DEFAULT_RETENTION_MS;
	}
	return DEFAULT_RETENTION_MS;
}
/**
* Sweep the session store and prune expired cron run sessions.
* Designed to be called from the cron timer tick — self-throttles via
* MIN_SWEEP_INTERVAL_MS to avoid excessive I/O.
*
* Lock ordering: this function acquires the session-store file lock via
* `updateSessionStore`. It must be called OUTSIDE of the cron service's
* own `locked()` section to avoid lock-order inversions. The cron timer
* calls this after all `locked()` sections have been released.
*/
async function sweepCronRunSessions(params) {
	const now = params.nowMs ?? Date.now();
	const storePath = params.sessionStorePath;
	const lastSweepAtMs = lastSweepAtMsByStore.get(storePath) ?? 0;
	if (!params.force && now - lastSweepAtMs < MIN_SWEEP_INTERVAL_MS) return {
		swept: false,
		pruned: 0
	};
	const retentionMs = resolveRetentionMs(params.cronConfig);
	if (retentionMs === null) {
		lastSweepAtMsByStore.set(storePath, now);
		return {
			swept: false,
			pruned: 0
		};
	}
	let pruned = 0;
	const prunedSessions = /* @__PURE__ */ new Map();
	try {
		await updateSessionStore(storePath, (store) => {
			const cutoff = now - retentionMs;
			for (const key of Object.keys(store)) {
				if (!isCronRunSessionKey(key)) continue;
				const entry = store[key];
				if (!entry) continue;
				if ((entry.updatedAt ?? 0) < cutoff) {
					if (!prunedSessions.has(entry.sessionId) || entry.sessionFile) prunedSessions.set(entry.sessionId, entry.sessionFile);
					delete store[key];
					pruned++;
				}
			}
		});
	} catch (err) {
		params.log.warn({ err: String(err) }, "cron-reaper: failed to sweep session store");
		return {
			swept: false,
			pruned: 0
		};
	}
	lastSweepAtMsByStore.set(storePath, now);
	if (prunedSessions.size > 0) try {
		const store = loadSessionStore(storePath, { skipCache: true });
		const archivedDirs = await archiveRemovedSessionTranscripts({
			removedSessionFiles: prunedSessions,
			referencedSessionIds: new Set(Object.values(store).map((entry) => entry?.sessionId).filter((id) => Boolean(id))),
			storePath,
			reason: "deleted",
			restrictToStoreDir: true
		});
		if (archivedDirs.size > 0) await cleanupArchivedSessionTranscripts({
			directories: [...archivedDirs],
			olderThanMs: retentionMs,
			reason: "deleted",
			nowMs: now
		});
	} catch (err) {
		params.log.warn({ err: String(err) }, "cron-reaper: transcript cleanup failed");
	}
	if (pruned > 0) params.log.info({
		pruned,
		retentionMs
	}, `cron-reaper: pruned ${pruned} expired cron run session(s)`);
	return {
		swept: true,
		pruned
	};
}
//#endregion
//#region src/cron/service/timeout-policy.ts
/**
* Maximum wall-clock time for a single job execution. Acts as a safety net
* on top of per-provider/per-agent timeouts to prevent one stuck job from
* wedging the entire cron lane.
*/
const DEFAULT_JOB_TIMEOUT_MS = 10 * 6e4;
/**
* Agent turns can legitimately run much longer than generic cron jobs.
* Use a larger safety ceiling when no explicit timeout is set.
*/
const AGENT_TURN_SAFETY_TIMEOUT_MS = 60 * 6e4;
function resolveCronJobTimeoutMs(job) {
	const configuredTimeoutMs = job.payload.kind === "agentTurn" && typeof job.payload.timeoutSeconds === "number" ? Math.floor(job.payload.timeoutSeconds * 1e3) : void 0;
	if (configuredTimeoutMs === void 0) return job.payload.kind === "agentTurn" ? AGENT_TURN_SAFETY_TIMEOUT_MS : DEFAULT_JOB_TIMEOUT_MS;
	return configuredTimeoutMs <= 0 ? void 0 : configuredTimeoutMs;
}
//#endregion
//#region src/cron/service/timer.ts
const MAX_TIMER_DELAY_MS = 6e4;
const CRON_TIMEOUT_CLEANUP_GUARD_MS = 2e4;
const CRON_AGENT_SETUP_WATCHDOG_MS = 6e4;
const CRON_AGENT_PRE_EXECUTION_WATCHDOG_MS = 6e4;
const CRON_AGENT_PRE_EXECUTION_MIN_WATCHDOG_MS = 1e3;
/**
* Minimum gap between consecutive fires of the same cron job.  This is a
* safety net that prevents spin-loops when `computeJobNextRunAtMs` returns
* a value within the same second as the just-completed run.  The guard
* is intentionally generous (2 s) so it never masks a legitimate schedule
* but always breaks an infinite re-trigger cycle.  (See #17821)
*/
const MIN_REFIRE_GAP_MS = 2e3;
const DEFAULT_MISSED_JOB_STAGGER_MS = 5e3;
const DEFAULT_MAX_MISSED_JOBS_PER_RESTART = 5;
const DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS = 2 * 6e4;
const DEFAULT_FAILURE_ALERT_AFTER = 2;
const DEFAULT_FAILURE_ALERT_COOLDOWN_MS = 60 * 6e4;
const CRON_AGENT_PHASE_WATCHDOG_STAGE = {
	runner_entered: "pre_execution",
	workspace: "pre_execution",
	runtime_plugins: "pre_execution",
	before_agent_reply: "execution",
	model_resolution: "pre_execution",
	auth: "pre_execution",
	context_engine: "pre_execution",
	attempt_dispatch: "execution",
	context_assembled: "execution",
	turn_accepted: "execution",
	process_spawned: "execution",
	tool_execution_started: "execution",
	assistant_output_started: "execution",
	model_call_started: "execution"
};
async function executeJobCoreWithTimeout(state, job) {
	const jobTimeoutMs = resolveCronJobTimeoutMs(job);
	if (typeof jobTimeoutMs !== "number") return await executeJobCore(state, job);
	const runAbortController = new AbortController();
	let timeoutReason;
	const timeoutMarker = Symbol("cron-timeout");
	let resolveTimeout;
	const timeoutPromise = new Promise((resolve) => {
		resolveTimeout = resolve;
	});
	const deferTimeoutUntilExecutionStart = job.sessionTarget !== "main" && job.payload.kind === "agentTurn";
	const triggerTimeout = (reason) => {
		if (runAbortController.signal.aborted) return;
		timeoutReason = reason;
		runAbortController.abort(reason);
		resolveTimeout?.(timeoutMarker);
	};
	const watchdog = createCronAgentWatchdog({
		deferUntilRunner: deferTimeoutUntilExecutionStart,
		jobTimeoutMs,
		triggerTimeout
	});
	const corePromise = executeJobCore(state, job, runAbortController.signal, {
		onExecutionStarted: deferTimeoutUntilExecutionStart ? watchdog.noteRunnerStarted : void 0,
		onExecutionPhase: deferTimeoutUntilExecutionStart ? watchdog.notePhase : void 0
	});
	watchdog.start();
	corePromise.catch((err) => {
		if (runAbortController.signal.aborted) state.deps.log.warn({
			jobId: job.id,
			err: String(err)
		}, "cron: job core rejected after timeout abort");
	});
	try {
		const first = await Promise.race([corePromise, timeoutPromise]);
		if (first !== timeoutMarker) return first;
		const activeExecution = watchdog.activeExecution();
		await cleanupTimedOutCronAgentRun(state, job, jobTimeoutMs, activeExecution);
		const error = timeoutReason ?? timeoutErrorMessage(activeExecution);
		return {
			status: "error",
			error,
			diagnostics: createCronRunDiagnosticsFromError("cron-setup", error, { nowMs: state.deps.nowMs })
		};
	} finally {
		watchdog.dispose();
	}
}
function createCronAgentWatchdog(params) {
	let state = params.deferUntilRunner ? "waiting_for_runner" : "executing";
	let timeoutId;
	let setupTimeoutId;
	let preExecutionTimeoutId;
	let activeExecution;
	const setTimedOut = (reason) => {
		if (state === "timed_out" || state === "disposed") return;
		state = "timed_out";
		params.triggerTimeout(reason);
	};
	const startTimeout = () => {
		if (timeoutId || state === "disposed") return;
		timeoutId = setTimeout(() => {
			setTimedOut(timeoutErrorMessage(activeExecution));
		}, params.jobTimeoutMs);
	};
	const clearSetupTimeout = () => {
		if (!setupTimeoutId) return;
		clearTimeout(setupTimeoutId);
		setupTimeoutId = void 0;
	};
	const clearPreExecutionTimeout = () => {
		if (!preExecutionTimeoutId) return;
		clearTimeout(preExecutionTimeoutId);
		preExecutionTimeoutId = void 0;
	};
	const startPreExecutionTimeout = () => {
		if (preExecutionTimeoutId || state !== "waiting_for_execution") return;
		preExecutionTimeoutId = setTimeout(() => {
			if (state === "waiting_for_execution") setTimedOut(preExecutionTimeoutErrorMessage(activeExecution));
		}, resolveCronAgentPreExecutionWatchdogMs(params.jobTimeoutMs));
	};
	const noteExecutionProgress = (info) => {
		if (!info) return;
		const previousPhase = activeExecution?.phase;
		activeExecution = {
			...activeExecution,
			...info
		};
		const stage = info.phase ? CRON_AGENT_PHASE_WATCHDOG_STAGE[info.phase] : void 0;
		if (state === "executing" && previousPhase === "before_agent_reply" && stage === "pre_execution") {
			state = "waiting_for_execution";
			startPreExecutionTimeout();
			return;
		}
		if (stage === "execution" || info.firstModelCallStarted) {
			state = "executing";
			clearPreExecutionTimeout();
		}
	};
	return {
		start: () => {
			if (params.deferUntilRunner) {
				setupTimeoutId = setTimeout(() => {
					if (state === "waiting_for_runner") setTimedOut(setupTimeoutErrorMessage(activeExecution));
				}, CRON_AGENT_SETUP_WATCHDOG_MS);
				return;
			}
			startTimeout();
		},
		noteRunnerStarted: (info) => {
			if (state === "disposed" || state === "timed_out") return;
			clearSetupTimeout();
			startTimeout();
			if (state !== "executing") state = "waiting_for_execution";
			noteExecutionProgress(info);
			startPreExecutionTimeout();
		},
		notePhase: (info) => {
			if (state === "disposed" || state === "timed_out") return;
			noteExecutionProgress(info);
		},
		activeExecution: () => activeExecution,
		dispose: () => {
			state = "disposed";
			if (timeoutId) clearTimeout(timeoutId);
			clearSetupTimeout();
			clearPreExecutionTimeout();
		}
	};
}
async function cleanupTimedOutCronAgentRun(state, job, timeoutMs, execution) {
	if (!state.deps.cleanupTimedOutAgentRun) return;
	let settleTimer;
	const cleanupPromise = state.deps.cleanupTimedOutAgentRun({
		job,
		timeoutMs,
		execution
	});
	const settleTimeout = new Promise((resolve) => {
		settleTimer = setTimeout(resolve, CRON_TIMEOUT_CLEANUP_GUARD_MS);
	});
	try {
		await Promise.race([cleanupPromise, settleTimeout]);
	} catch (err) {
		state.deps.log.warn({
			jobId: job.id,
			err: String(err)
		}, "cron: timed-out agent cleanup failed");
	} finally {
		if (settleTimer) clearTimeout(settleTimer);
	}
}
function resolveRunConcurrency(state) {
	const raw = state.deps.cronConfig?.maxConcurrentRuns;
	if (typeof raw !== "number" || !Number.isFinite(raw)) return 1;
	return Math.max(1, Math.floor(raw));
}
function timeoutErrorMessage(execution) {
	const phase = formatCronAgentExecutionPhase(execution);
	if (!phase) return "cron: job execution timed out";
	return `cron: job execution timed out (last phase: ${phase})`;
}
function setupTimeoutErrorMessage(execution) {
	const phase = formatCronAgentExecutionPhase(execution);
	if (!phase) return "cron: isolated agent setup timed out before runner start";
	return `cron: isolated agent setup timed out before runner start (last phase: ${phase})`;
}
function preExecutionTimeoutErrorMessage(execution) {
	const phase = formatCronAgentExecutionPhase(execution);
	if (!phase) return "cron: isolated agent run stalled before execution start";
	return `cron: isolated agent run stalled before execution start (last phase: ${phase})`;
}
function formatCronAgentExecutionPhase(execution) {
	return formatEmbeddedAgentExecutionPhase(execution?.phase);
}
function resolveCronAgentPreExecutionWatchdogMs(jobTimeoutMs) {
	return Math.max(CRON_AGENT_PRE_EXECUTION_MIN_WATCHDOG_MS, Math.min(CRON_AGENT_PRE_EXECUTION_WATCHDOG_MS, Math.floor(jobTimeoutMs / 2)));
}
function abortErrorMessage(signal) {
	const reason = signal?.reason;
	if (typeof reason === "string" && reason.trim()) return reason.trim();
	return timeoutErrorMessage();
}
function isAbortError(err) {
	if (!(err instanceof Error)) return false;
	return err.name === "AbortError" || err.message === timeoutErrorMessage();
}
function normalizeCronRunErrorText(err) {
	if (isAbortError(err)) return timeoutErrorMessage();
	if (typeof err === "string") return err === `Error: ${timeoutErrorMessage()}` ? timeoutErrorMessage() : err;
	return String(err);
}
function normalizeCronLaneSegment(value, fallback) {
	return normalizeOptionalLowercaseString(value)?.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || fallback;
}
function resolveMainSessionCronRunSessionKey(job, startedAt) {
	const explicitAgentId = job.agentId?.trim();
	return `agent:${normalizeAgentId(explicitAgentId || resolveAgentIdFromSessionKey(job.sessionKey))}:cron:${normalizeCronLaneSegment(job.id, "job")}:run:${normalizeCronLaneSegment(String(Math.max(0, Math.floor(startedAt))), "run")}`;
}
function resolveMainSessionCronDeliveryContext(state, job) {
	const targetSessionKey = job.sessionKey?.trim();
	if (!targetSessionKey) return;
	const explicitAgentId = job.agentId?.trim();
	const agentId = normalizeAgentId(explicitAgentId || resolveAgentIdFromSessionKey(targetSessionKey));
	const storePath = state.deps.resolveSessionStorePath?.(agentId) ?? state.deps.sessionStorePath;
	if (!storePath) return;
	try {
		return deliveryContextFromSession(readSessionEntry(storePath, targetSessionKey));
	} catch {
		return;
	}
}
function resolveCronTaskChildSessionKey(params) {
	if (params.job.sessionTarget === "main") return resolveMainSessionCronRunSessionKey(params.job, params.startedAt);
	const explicitSessionKey = params.job.sessionKey?.trim();
	if (explicitSessionKey) return explicitSessionKey;
	if (params.job.sessionTarget !== "isolated") return;
	return resolveCronAgentSessionKey({
		sessionKey: `cron:${params.job.id}`,
		agentId: params.job.agentId ?? params.state.deps.defaultAgentId ?? "main"
	});
}
function tryCreateCronTaskRun(params) {
	const runId = createCronExecutionId(params.job.id, params.startedAt);
	try {
		createRunningTaskRun({
			runtime: "cron",
			sourceId: params.job.id,
			ownerKey: "",
			scopeKind: "system",
			childSessionKey: resolveCronTaskChildSessionKey(params),
			agentId: params.job.agentId,
			runId,
			label: params.job.name,
			task: params.job.name || params.job.id,
			deliveryStatus: "not_applicable",
			notifyPolicy: "silent",
			startedAt: params.startedAt,
			lastEventAt: params.startedAt
		});
		return runId;
	} catch (error) {
		params.state.deps.log.warn({
			jobId: params.job.id,
			error
		}, "cron: failed to create task ledger record");
		return;
	}
}
function tryFinishCronTaskRun(state, result) {
	if (!result.taskRunId) return;
	try {
		if (result.status === "ok" || result.status === "skipped") {
			completeTaskRunByRunId({
				runId: result.taskRunId,
				runtime: "cron",
				endedAt: result.endedAt,
				lastEventAt: result.endedAt,
				terminalSummary: result.summary ?? void 0
			});
			return;
		}
		failTaskRunByRunId({
			runId: result.taskRunId,
			runtime: "cron",
			status: normalizeCronRunErrorText(result.error) === timeoutErrorMessage() ? "timed_out" : "failed",
			endedAt: result.endedAt,
			lastEventAt: result.endedAt,
			error: result.status === "error" ? normalizeCronRunErrorText(result.error) : void 0,
			terminalSummary: result.summary ?? void 0
		});
	} catch (error) {
		state.deps.log.warn({
			runId: result.taskRunId,
			jobStatus: result.status,
			error
		}, "cron: failed to update task ledger record");
	}
}
/** Default max retries for one-shot jobs on transient errors (#24355). */
const DEFAULT_MAX_TRANSIENT_RETRIES = 3;
function resolveCronNextRunWithLowerBound(params) {
	if (params.naturalNext === void 0) {
		params.state.deps.log.warn({
			jobId: params.job.id,
			jobName: params.job.name,
			context: params.context
		}, "cron: next run unresolved; clearing schedule to avoid a refire loop");
		return;
	}
	return Math.max(params.naturalNext, params.lowerBoundMs);
}
function resolveRetryConfig(cronConfig) {
	const retry = cronConfig?.retry;
	return {
		maxAttempts: typeof retry?.maxAttempts === "number" ? retry.maxAttempts : DEFAULT_MAX_TRANSIENT_RETRIES,
		backoffMs: Array.isArray(retry?.backoffMs) && retry.backoffMs.length > 0 ? retry.backoffMs : DEFAULT_ERROR_BACKOFF_SCHEDULE_MS.slice(0, 3),
		retryOn: Array.isArray(retry?.retryOn) && retry.retryOn.length > 0 ? retry.retryOn : void 0
	};
}
function resolveDeliveryState(params) {
	const primaryDeliveryRequested = resolveCronDeliveryPlan(params.job).requested;
	const alternateFailureNotificationRequested = params.runStatus === "error" && params.job.delivery?.bestEffort !== true && resolveFailureDestination(params.job, params.globalFailureDestination) !== null;
	if (!primaryDeliveryRequested) return {
		status: "not-requested",
		failureNotification: { status: alternateFailureNotificationRequested ? "unknown" : "not-requested" }
	};
	if (params.runStatus === "error") {
		const failureNotification = alternateFailureNotificationRequested ? { status: "unknown" } : { status: "delivered" };
		if (params.delivered === true) return {
			delivered: false,
			status: "not-delivered",
			error: params.error,
			failureNotification: alternateFailureNotificationRequested ? failureNotification : {
				delivered: true,
				status: "delivered"
			}
		};
		if (params.delivered === false) return {
			delivered: false,
			status: "not-delivered",
			error: params.error,
			failureNotification: alternateFailureNotificationRequested ? failureNotification : {
				delivered: false,
				status: "not-delivered",
				...params.error ? { error: params.error } : {}
			}
		};
		return {
			status: "unknown",
			error: params.error,
			failureNotification: { status: "unknown" }
		};
	}
	if (params.delivered === true) return {
		delivered: true,
		status: "delivered",
		failureNotification: { status: "not-requested" }
	};
	if (params.delivered === false) return {
		delivered: false,
		status: "not-delivered",
		error: params.error,
		failureNotification: { status: "not-requested" }
	};
	return {
		status: "unknown",
		failureNotification: { status: "not-requested" }
	};
}
function failureNotificationDeliveryFromJobState(job) {
	const status = job.state.lastFailureNotificationDeliveryStatus;
	if (!status || status === "not-requested") return;
	return {
		delivered: job.state.lastFailureNotificationDelivered,
		status,
		error: job.state.lastFailureNotificationDeliveryError
	};
}
function normalizeCronMessageChannel(input) {
	const channel = normalizeOptionalLowercaseString(input);
	return channel ? channel : void 0;
}
function normalizeTo(input) {
	if (typeof input !== "string") return;
	const to = input.trim();
	return to ? to : void 0;
}
function clampPositiveInt(value, fallback) {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const floored = Math.floor(value);
	return floored >= 1 ? floored : fallback;
}
function clampNonNegativeInt(value, fallback) {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const floored = Math.floor(value);
	return floored >= 0 ? floored : fallback;
}
function resolveFailureAlert(state, job) {
	const globalConfig = state.deps.cronConfig?.failureAlert;
	const jobConfig = job.failureAlert === false ? void 0 : job.failureAlert;
	if (job.failureAlert === false) return null;
	if (!jobConfig && globalConfig?.enabled !== true) return null;
	const mode = jobConfig?.mode ?? globalConfig?.mode;
	const explicitTo = normalizeTo(jobConfig?.to);
	return {
		after: clampPositiveInt(jobConfig?.after ?? globalConfig?.after, DEFAULT_FAILURE_ALERT_AFTER),
		cooldownMs: clampNonNegativeInt(jobConfig?.cooldownMs ?? globalConfig?.cooldownMs, DEFAULT_FAILURE_ALERT_COOLDOWN_MS),
		channel: normalizeCronMessageChannel(jobConfig?.channel) ?? normalizeCronMessageChannel(job.delivery?.channel) ?? "last",
		to: mode === "webhook" ? explicitTo : explicitTo ?? normalizeTo(job.delivery?.to),
		mode,
		accountId: jobConfig?.accountId ?? globalConfig?.accountId,
		includeSkipped: jobConfig?.includeSkipped ?? globalConfig?.includeSkipped ?? false
	};
}
function emitFailureAlert(state, params) {
	const safeJobName = params.job.name || params.job.id;
	const truncatedError = (params.error?.trim() || "unknown reason").slice(0, 200);
	const statusVerb = params.status === "skipped" ? "skipped" : "failed";
	const detailLabel = params.status === "skipped" ? "Skip reason" : "Last error";
	const text = [`Cron job "${safeJobName}" ${statusVerb} ${params.consecutiveErrors} times`, `${detailLabel}: ${truncatedError}`].join("\n");
	if (state.deps.sendCronFailureAlert) {
		state.deps.sendCronFailureAlert({
			job: params.job,
			text,
			channel: params.channel,
			to: params.to,
			mode: params.mode,
			accountId: params.accountId
		}).catch((err) => {
			state.deps.log.warn({
				jobId: params.job.id,
				err: String(err)
			}, "cron: failure alert delivery failed");
		});
		return;
	}
	state.deps.enqueueSystemEvent(text, { agentId: params.job.agentId });
	if (params.job.wakeMode === "now") state.deps.requestHeartbeat({
		source: "cron",
		intent: "immediate",
		reason: `cron:${params.job.id}:failure-alert`
	});
}
function maybeEmitFailureAlert(state, params) {
	if (!params.alertConfig || params.consecutiveCount < params.alertConfig.after) return;
	if (params.job.delivery?.bestEffort === true) return;
	const now = state.deps.nowMs();
	const lastAlert = params.job.state.lastFailureAlertAtMs;
	if (typeof lastAlert === "number" && now - lastAlert < Math.max(0, params.alertConfig.cooldownMs)) return;
	emitFailureAlert(state, {
		job: params.job,
		error: params.error,
		consecutiveErrors: params.consecutiveCount,
		channel: params.alertConfig.channel,
		to: params.alertConfig.to,
		mode: params.alertConfig.mode,
		accountId: params.alertConfig.accountId,
		status: params.status
	});
	params.job.state.lastFailureAlertAtMs = now;
}
/**
* Apply the result of a job execution to the job's state.
* Handles consecutive error tracking, exponential backoff, one-shot disable,
* and nextRunAtMs computation. Returns `true` if the job should be deleted.
*/
function applyJobResult(state, job, result, opts) {
	const prevLastRunAtMs = job.state.lastRunAtMs;
	const computeNextWithPreservedLastRun = (nowMs) => {
		const saved = job.state.lastRunAtMs;
		job.state.lastRunAtMs = prevLastRunAtMs;
		try {
			return computeJobNextRunAtMs(job, nowMs);
		} finally {
			job.state.lastRunAtMs = saved;
		}
	};
	job.state.runningAtMs = void 0;
	job.state.lastRunAtMs = result.startedAt;
	job.state.lastRunStatus = result.status;
	job.state.lastStatus = result.status;
	job.state.lastDurationMs = Math.max(0, result.endedAt - result.startedAt);
	job.state.lastError = result.error;
	job.state.lastDiagnostics = normalizeCronRunDiagnostics(result.diagnostics);
	job.state.lastDiagnosticSummary = summarizeCronRunDiagnostics(job.state.lastDiagnostics);
	job.state.lastErrorReason = result.status === "error" && typeof result.error === "string" ? resolveFailoverReasonFromError(result.error) ?? void 0 : void 0;
	if (result.status === "error") state.deps.log.warn({
		jobId: job.id,
		jobName: job.name,
		error: result.error,
		diagnosticsSummary: job.state.lastDiagnosticSummary
	}, "cron: job run returned error status");
	const deliveryState = resolveDeliveryState({
		job,
		runStatus: result.status,
		delivered: result.delivered,
		error: result.error,
		globalFailureDestination: state.deps.cronConfig?.failureDestination
	});
	job.state.lastDelivered = deliveryState.delivered;
	job.state.lastDeliveryStatus = deliveryState.status;
	job.state.lastDeliveryError = deliveryState.status === "not-delivered" && deliveryState.error ? deliveryState.error : void 0;
	job.state.lastFailureNotificationDelivered = deliveryState.failureNotification.delivered;
	job.state.lastFailureNotificationDeliveryStatus = deliveryState.failureNotification.status;
	job.state.lastFailureNotificationDeliveryError = deliveryState.failureNotification.error;
	job.updatedAtMs = result.endedAt;
	const alertConfig = resolveFailureAlert(state, job);
	if (result.status === "error") {
		job.state.consecutiveErrors = (job.state.consecutiveErrors ?? 0) + 1;
		job.state.consecutiveSkipped = 0;
		maybeEmitFailureAlert(state, {
			job,
			alertConfig,
			status: "error",
			error: result.error,
			consecutiveCount: job.state.consecutiveErrors
		});
	} else if (result.status === "skipped") {
		job.state.consecutiveErrors = 0;
		job.state.consecutiveSkipped = (job.state.consecutiveSkipped ?? 0) + 1;
		if (alertConfig?.includeSkipped) maybeEmitFailureAlert(state, {
			job,
			alertConfig,
			status: "skipped",
			error: result.error,
			consecutiveCount: job.state.consecutiveSkipped
		});
		else job.state.lastFailureAlertAtMs = void 0;
	} else {
		job.state.consecutiveErrors = 0;
		job.state.consecutiveSkipped = 0;
		job.state.lastFailureAlertAtMs = void 0;
	}
	const shouldDelete = job.schedule.kind === "at" && job.deleteAfterRun === true && result.status === "ok";
	if (!shouldDelete) if (job.schedule.kind === "at") {
		if (result.status === "ok" || result.status === "skipped") {
			job.enabled = false;
			job.state.nextRunAtMs = void 0;
		} else if (result.status === "error") {
			const retryConfig = resolveRetryConfig(state.deps.cronConfig);
			const retryHint = resolveCronExecutionRetryHint(result.error, retryConfig.retryOn, job.state.lastErrorReason);
			const consecutive = job.state.consecutiveErrors;
			if (retryHint.retryable && consecutive <= retryConfig.maxAttempts) {
				const backoff = errorBackoffMs(consecutive, retryConfig.backoffMs);
				job.state.nextRunAtMs = result.endedAt + backoff;
				state.deps.log.info({
					jobId: job.id,
					jobName: job.name,
					consecutiveErrors: consecutive,
					backoffMs: backoff,
					nextRunAtMs: job.state.nextRunAtMs
				}, "cron: scheduling one-shot retry after transient error");
			} else {
				job.enabled = false;
				job.state.nextRunAtMs = void 0;
				state.deps.log.warn({
					jobId: job.id,
					jobName: job.name,
					consecutiveErrors: consecutive,
					error: result.error,
					reason: retryHint.retryable ? "max retries exhausted" : "permanent error",
					retryCategory: retryHint.category
				}, "cron: disabling one-shot job after error");
			}
		}
	} else if (result.status === "error" && isJobEnabled(job)) {
		const backoff = errorBackoffMs(job.state.consecutiveErrors ?? 1);
		let normalNext;
		try {
			normalNext = opts?.preserveSchedule && job.schedule.kind === "every" ? computeNextWithPreservedLastRun(result.endedAt) : computeJobNextRunAtMs(job, result.endedAt);
		} catch (err) {
			recordScheduleComputeError({
				state,
				job,
				err
			});
		}
		const backoffNext = result.endedAt + backoff;
		job.state.nextRunAtMs = job.schedule.kind === "cron" ? resolveCronNextRunWithLowerBound({
			state,
			job,
			naturalNext: normalNext,
			lowerBoundMs: backoffNext,
			context: "error_backoff"
		}) : normalNext !== void 0 ? Math.max(normalNext, backoffNext) : backoffNext;
		state.deps.log.info({
			jobId: job.id,
			consecutiveErrors: job.state.consecutiveErrors,
			backoffMs: backoff,
			nextRunAtMs: job.state.nextRunAtMs
		}, "cron: applying error backoff");
	} else if (isJobEnabled(job)) {
		let naturalNext;
		try {
			naturalNext = opts?.preserveSchedule && job.schedule.kind === "every" ? computeNextWithPreservedLastRun(result.endedAt) : computeJobNextRunAtMs(job, result.endedAt);
		} catch (err) {
			recordScheduleComputeError({
				state,
				job,
				err
			});
		}
		if (job.schedule.kind === "cron") {
			const minNext = result.endedAt + MIN_REFIRE_GAP_MS;
			job.state.nextRunAtMs = resolveCronNextRunWithLowerBound({
				state,
				job,
				naturalNext,
				lowerBoundMs: minNext,
				context: "completion"
			});
		} else job.state.nextRunAtMs = naturalNext;
	} else job.state.nextRunAtMs = void 0;
	return shouldDelete;
}
function applyOutcomeToStoredJob(state, result) {
	clearCronJobActive(result.jobId);
	tryFinishCronTaskRun(state, result);
	const store = state.store;
	if (!store) return;
	const jobs = store.jobs;
	const job = jobs.find((entry) => entry.id === result.jobId);
	if (!job) {
		if (result.status === "ok") {
			applyJobResult(state, result.job, {
				status: result.status,
				error: result.error,
				diagnostics: result.diagnostics,
				delivered: result.delivered,
				startedAt: result.startedAt,
				endedAt: result.endedAt
			});
			emitJobFinished(state, result.job, result, result.startedAt);
			state.deps.log.info({ jobId: result.jobId }, "cron: finalized successful run after job was removed during execution");
			return;
		}
		state.deps.log.warn({ jobId: result.jobId }, "cron: applyOutcomeToStoredJob — job not found after forceReload, result discarded");
		return;
	}
	const shouldDelete = applyJobResult(state, job, {
		status: result.status,
		error: result.error,
		diagnostics: result.diagnostics,
		delivered: result.delivered,
		startedAt: result.startedAt,
		endedAt: result.endedAt
	});
	emitJobFinished(state, job, result, result.startedAt);
	if (shouldDelete) {
		store.jobs = jobs.filter((entry) => entry.id !== job.id);
		emit(state, {
			jobId: job.id,
			action: "removed",
			job
		});
	}
}
function armTimer(state) {
	if (state.timer) clearTimeout(state.timer);
	state.timer = null;
	if (!state.deps.cronEnabled) {
		state.deps.log.debug({}, "cron: armTimer skipped - scheduler disabled");
		return;
	}
	const nextAt = nextWakeAtMs(state);
	if (!nextAt) {
		const jobCount = state.store?.jobs.length ?? 0;
		const enabledCount = state.store?.jobs.filter((j) => j.enabled).length ?? 0;
		const withNextRun = state.store?.jobs.filter((j) => j.enabled && hasScheduledNextRunAtMs(j.state.nextRunAtMs)).length ?? 0;
		if (enabledCount > 0) {
			armRunningRecheckTimer(state);
			state.deps.log.debug({
				jobCount,
				enabledCount,
				withNextRun,
				delayMs: MAX_TIMER_DELAY_MS
			}, "cron: timer armed for maintenance recheck");
			return;
		}
		state.deps.log.debug({
			jobCount,
			enabledCount,
			withNextRun
		}, "cron: armTimer skipped - no jobs with nextRunAtMs");
		return;
	}
	const now = state.deps.nowMs();
	const delay = Math.max(nextAt - now, 0);
	const clampedDelay = Math.min(delay === 0 ? MIN_REFIRE_GAP_MS : delay, MAX_TIMER_DELAY_MS);
	state.timer = setTimeout(() => {
		onTimer(state).catch((err) => {
			state.deps.log.error({ err: String(err) }, "cron: timer tick failed");
		});
	}, clampedDelay);
	state.deps.log.debug({
		nextAt,
		delayMs: clampedDelay,
		clamped: delay > MAX_TIMER_DELAY_MS
	}, "cron: timer armed");
}
function armRunningRecheckTimer(state) {
	if (state.timer) clearTimeout(state.timer);
	state.timer = setTimeout(() => {
		onTimer(state).catch((err) => {
			state.deps.log.error({ err: String(err) }, "cron: timer tick failed");
		});
	}, MAX_TIMER_DELAY_MS);
}
async function onTimer(state) {
	if (state.running) {
		armRunningRecheckTimer(state);
		return;
	}
	state.running = true;
	armRunningRecheckTimer(state);
	try {
		const dueJobs = await locked(state, async () => {
			await ensureLoaded(state, {
				forceReload: true,
				skipRecompute: true
			});
			const dueCheckNow = state.deps.nowMs();
			const due = collectRunnableJobs(state, dueCheckNow);
			if (due.length === 0) {
				if (recomputeNextRunsForMaintenance(state, {
					recomputeExpired: true,
					nowMs: dueCheckNow
				})) await persist(state);
				return [];
			}
			const now = state.deps.nowMs();
			for (const job of due) {
				job.state.runningAtMs = now;
				job.state.lastError = void 0;
			}
			await persist(state);
			return due.map((j) => ({
				id: j.id,
				job: j
			}));
		});
		const runDueJob = async (params) => {
			const { id, job } = params;
			const startedAt = state.deps.nowMs();
			job.state.runningAtMs = startedAt;
			markCronJobActive(job.id);
			emit(state, {
				jobId: job.id,
				action: "started",
				job,
				runAtMs: startedAt
			});
			const jobTimeoutMs = resolveCronJobTimeoutMs(job);
			const taskRunId = tryCreateCronTaskRun({
				state,
				job,
				startedAt
			});
			try {
				return {
					jobId: id,
					job,
					taskRunId,
					...await executeJobCoreWithTimeout(state, job),
					startedAt,
					endedAt: state.deps.nowMs()
				};
			} catch (err) {
				const errorText = normalizeCronRunErrorText(err);
				state.deps.log.warn({
					jobId: id,
					jobName: job.name,
					timeoutMs: jobTimeoutMs ?? null
				}, `cron: job failed: ${errorText}`);
				return {
					jobId: id,
					job,
					taskRunId,
					status: "error",
					error: errorText,
					diagnostics: createCronRunDiagnosticsFromError("cron-setup", errorText, { nowMs: state.deps.nowMs }),
					startedAt,
					endedAt: state.deps.nowMs()
				};
			}
		};
		const concurrency = Math.min(resolveRunConcurrency(state), Math.max(1, dueJobs.length));
		const results = Array.from({ length: dueJobs.length });
		let cursor = 0;
		const workers = Array.from({ length: concurrency }, async () => {
			for (;;) {
				const index = cursor++;
				if (index >= dueJobs.length) return;
				const due = dueJobs[index];
				if (!due) return;
				results[index] = await runDueJob(due);
			}
		});
		await Promise.all(workers);
		const completedResults = results.filter((entry) => entry !== void 0);
		if (completedResults.length > 0) await locked(state, async () => {
			await ensureLoaded(state, {
				forceReload: true,
				skipRecompute: true
			});
			for (const result of completedResults) applyOutcomeToStoredJob(state, result);
			recomputeNextRunsForMaintenance(state);
			await persist(state);
		});
	} finally {
		const storePaths = /* @__PURE__ */ new Set();
		if (state.deps.resolveSessionStorePath) {
			const defaultAgentId = state.deps.defaultAgentId ?? "main";
			if (state.store?.jobs?.length) for (const job of state.store.jobs) {
				const agentId = typeof job.agentId === "string" && job.agentId.trim() ? job.agentId : defaultAgentId;
				storePaths.add(state.deps.resolveSessionStorePath(agentId));
			}
			else storePaths.add(state.deps.resolveSessionStorePath(defaultAgentId));
		} else if (state.deps.sessionStorePath) storePaths.add(state.deps.sessionStorePath);
		if (storePaths.size > 0) {
			const nowMs = state.deps.nowMs();
			for (const storePath of storePaths) try {
				await sweepCronRunSessions({
					cronConfig: state.deps.cronConfig,
					sessionStorePath: storePath,
					nowMs,
					log: state.deps.log
				});
			} catch (err) {
				state.deps.log.warn({
					err: String(err),
					storePath
				}, "cron: session reaper sweep failed");
			}
		}
		state.running = false;
		armTimer(state);
	}
}
function isRunnableJob(params) {
	const { job, nowMs } = params;
	if (!job.state) job.state = {};
	if (!isJobEnabled(job)) return false;
	if (params.skipJobIds?.has(job.id)) return false;
	if (typeof job.state.runningAtMs === "number") return false;
	if (params.skipAtIfAlreadyRan && job.schedule.kind === "at" && job.state.lastStatus) {
		const lastRun = job.state.lastRunAtMs;
		const nextRun = job.state.nextRunAtMs;
		if (job.state.lastStatus === "error" && isJobEnabled(job) && typeof nextRun === "number" && typeof lastRun === "number" && nextRun > lastRun) return nowMs >= nextRun;
		return false;
	}
	const next = job.state.nextRunAtMs;
	if (hasScheduledNextRunAtMs(next) && nowMs >= next) return true;
	if (hasScheduledNextRunAtMs(next) && next > nowMs && isErrorBackoffPending(job, nowMs)) return false;
	if (!params.allowCronMissedRunByLastRun || job.schedule.kind !== "cron") return false;
	let previousRunAtMs;
	try {
		previousRunAtMs = computeJobPreviousRunAtMs(job, nowMs);
	} catch {
		return false;
	}
	if (typeof previousRunAtMs !== "number" || !Number.isFinite(previousRunAtMs)) return false;
	const lastRunAtMs = job.state.lastRunAtMs;
	if (typeof lastRunAtMs !== "number" || !Number.isFinite(lastRunAtMs)) return false;
	return previousRunAtMs > lastRunAtMs;
}
function isErrorBackoffPending(job, nowMs) {
	if (job.schedule.kind === "at" || job.state.lastStatus !== "error") return false;
	const lastRunAtMs = job.state.lastRunAtMs;
	if (typeof lastRunAtMs !== "number" || !Number.isFinite(lastRunAtMs)) return false;
	const consecutiveErrorsRaw = job.state.consecutiveErrors;
	return nowMs < lastRunAtMs + errorBackoffMs(typeof consecutiveErrorsRaw === "number" && Number.isFinite(consecutiveErrorsRaw) ? Math.max(1, Math.floor(consecutiveErrorsRaw)) : 1);
}
function collectRunnableJobs(state, nowMs, opts) {
	if (!state.store) return [];
	return state.store.jobs.filter((job) => isRunnableJob({
		job,
		nowMs,
		skipJobIds: opts?.skipJobIds,
		skipAtIfAlreadyRan: opts?.skipAtIfAlreadyRan,
		allowCronMissedRunByLastRun: opts?.allowCronMissedRunByLastRun
	}));
}
async function runMissedJobs(state, opts) {
	const plan = await planStartupCatchup(state, opts);
	if (plan.candidates.length === 0 && plan.deferredJobs.length === 0) return;
	await applyStartupCatchupOutcomes(state, plan, await executeStartupCatchupPlan(state, plan));
}
async function planStartupCatchup(state, opts) {
	const maxImmediate = Math.max(0, state.deps.maxMissedJobsPerRestart ?? DEFAULT_MAX_MISSED_JOBS_PER_RESTART);
	return locked(state, async () => {
		await ensureLoaded(state, { skipRecompute: true });
		if (!state.store) return {
			candidates: [],
			deferredJobs: []
		};
		const now = state.deps.nowMs();
		const missed = collectRunnableJobs(state, now, {
			skipJobIds: opts?.skipJobIds,
			skipAtIfAlreadyRan: true,
			allowCronMissedRunByLastRun: true
		});
		if (missed.length === 0) return {
			candidates: [],
			deferredJobs: []
		};
		const sorted = missed.toSorted((a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0));
		const deferredAgentJobs = opts?.deferAgentTurnJobs ? sorted.filter((job) => job.payload.kind === "agentTurn") : [];
		const startupEligible = opts?.deferAgentTurnJobs ? sorted.filter((job) => job.payload.kind !== "agentTurn") : sorted;
		const startupCandidates = startupEligible.slice(0, maxImmediate);
		const deferredOverflow = startupEligible.slice(maxImmediate);
		const deferredAgentDelayMs = Math.max(0, state.deps.startupDeferredMissedAgentJobDelayMs ?? DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS);
		const deferred = [...deferredOverflow.map((job) => ({ jobId: job.id })), ...deferredAgentJobs.map((job) => ({
			jobId: job.id,
			delayMs: deferredAgentDelayMs
		}))];
		if (deferred.length > 0) state.deps.log.info({
			immediateCount: startupCandidates.length,
			deferredCount: deferred.length,
			totalMissed: missed.length
		}, "cron: staggering missed jobs to prevent gateway overload");
		if (deferredAgentJobs.length > 0) state.deps.log.info({
			count: deferredAgentJobs.length,
			jobIds: deferredAgentJobs.map((job) => job.id),
			delayMs: deferredAgentDelayMs
		}, "cron: deferring missed agent jobs until after gateway startup");
		if (startupCandidates.length > 0) state.deps.log.info({
			count: startupCandidates.length,
			jobIds: startupCandidates.map((j) => j.id)
		}, "cron: running missed jobs after restart");
		for (const job of startupCandidates) {
			job.state.runningAtMs = now;
			job.state.lastError = void 0;
		}
		await persist(state);
		return {
			candidates: startupCandidates.map((job) => ({
				jobId: job.id,
				job
			})),
			deferredJobs: deferred
		};
	});
}
async function executeStartupCatchupPlan(state, plan) {
	const outcomes = [];
	for (const candidate of plan.candidates) outcomes.push(await runStartupCatchupCandidate(state, candidate));
	return outcomes;
}
async function runStartupCatchupCandidate(state, candidate) {
	const startedAt = state.deps.nowMs();
	const taskRunId = tryCreateCronTaskRun({
		state,
		job: candidate.job,
		startedAt
	});
	emit(state, {
		jobId: candidate.job.id,
		action: "started",
		job: candidate.job,
		runAtMs: startedAt
	});
	try {
		const result = await executeJobCoreWithTimeout(state, candidate.job);
		return {
			jobId: candidate.jobId,
			job: candidate.job,
			taskRunId,
			status: result.status,
			error: result.error,
			summary: result.summary,
			diagnostics: result.diagnostics,
			delivered: result.delivered,
			sessionId: result.sessionId,
			sessionKey: result.sessionKey,
			model: result.model,
			provider: result.provider,
			usage: result.usage,
			startedAt,
			endedAt: state.deps.nowMs()
		};
	} catch (err) {
		return {
			jobId: candidate.jobId,
			job: candidate.job,
			taskRunId,
			status: "error",
			error: normalizeCronRunErrorText(err),
			diagnostics: createCronRunDiagnosticsFromError("cron-setup", normalizeCronRunErrorText(err), { nowMs: state.deps.nowMs }),
			startedAt,
			endedAt: state.deps.nowMs()
		};
	}
}
async function applyStartupCatchupOutcomes(state, plan, outcomes) {
	const staggerMs = Math.max(0, state.deps.missedJobStaggerMs ?? DEFAULT_MISSED_JOB_STAGGER_MS);
	await locked(state, async () => {
		await ensureLoaded(state, { skipRecompute: true });
		if (!state.store) return;
		for (const result of outcomes) applyOutcomeToStoredJob(state, result);
		if (plan.deferredJobs.length > 0) {
			const baseNow = state.deps.nowMs();
			let offset = staggerMs;
			for (const deferred of plan.deferredJobs) {
				const jobId = deferred.jobId;
				const job = state.store.jobs.find((entry) => entry.id === jobId);
				if (!job || !isJobEnabled(job)) continue;
				if (typeof deferred.delayMs === "number") {
					job.state.nextRunAtMs = baseNow + deferred.delayMs + offset - staggerMs;
					offset += staggerMs;
					continue;
				}
				job.state.nextRunAtMs = baseNow + offset;
				offset += staggerMs;
			}
		}
		recomputeNextRunsForMaintenance(state, { repairFutureCronNextRunAtMs: false });
		await persist(state);
	});
}
async function executeJobCore(state, job, abortSignal, options) {
	const resolveAbortError = () => ({
		status: "error",
		error: abortErrorMessage(abortSignal)
	});
	const waitWithAbort = async (ms) => {
		if (!abortSignal) {
			await new Promise((resolve) => setTimeout(resolve, ms));
			return;
		}
		if (abortSignal.aborted) return;
		await new Promise((resolve) => {
			const timer = setTimeout(() => {
				abortSignal.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			const onAbort = () => {
				clearTimeout(timer);
				abortSignal.removeEventListener("abort", onAbort);
				resolve();
			};
			abortSignal.addEventListener("abort", onAbort, { once: true });
		});
	};
	if (abortSignal?.aborted) return resolveAbortError();
	if (job.sessionTarget === "main") return await executeMainSessionCronJob(state, job, abortSignal, waitWithAbort);
	return await executeDetachedCronJob(state, job, abortSignal, resolveAbortError, options);
}
async function executeMainSessionCronJob(state, job, abortSignal, waitWithAbort) {
	const text = resolveJobPayloadTextForMain(job);
	if (!text) return {
		status: "skipped",
		error: job.payload.kind === "systemEvent" ? "main job requires non-empty systemEvent text" : "main job requires payload.kind=\"systemEvent\""
	};
	const cronRunSessionKey = resolveMainSessionCronRunSessionKey(job, typeof job.state.runningAtMs === "number" ? job.state.runningAtMs : state.deps.nowMs());
	const deliveryContext = resolveMainSessionCronDeliveryContext(state, job);
	state.deps.enqueueSystemEvent(text, {
		agentId: job.agentId,
		sessionKey: cronRunSessionKey,
		contextKey: `cron:${job.id}`,
		...deliveryContext ? { deliveryContext } : {}
	});
	if (job.wakeMode === "now" && state.deps.runHeartbeatOnce) {
		const reason = `cron:${job.id}`;
		const maxWaitMs = state.deps.wakeNowHeartbeatBusyMaxWaitMs ?? 2 * 6e4;
		const retryDelayMs = state.deps.wakeNowHeartbeatBusyRetryDelayMs ?? 250;
		const waitStartedAt = state.deps.nowMs();
		let heartbeatResult;
		for (;;) {
			if (abortSignal?.aborted) return {
				status: "error",
				error: timeoutErrorMessage()
			};
			heartbeatResult = await state.deps.runHeartbeatOnce({
				source: "cron",
				intent: "immediate",
				reason,
				agentId: job.agentId,
				sessionKey: cronRunSessionKey,
				heartbeat: { target: "last" }
			});
			if (heartbeatResult.status !== "skipped" || !isRetryableHeartbeatBusySkipReason(heartbeatResult.reason)) break;
			if (heartbeatResult.reason === "cron-in-progress") {
				state.deps.requestHeartbeat({
					source: "cron",
					intent: "immediate",
					reason,
					agentId: job.agentId,
					sessionKey: cronRunSessionKey,
					heartbeat: { target: "last" }
				});
				return {
					status: "ok",
					summary: text,
					sessionKey: cronRunSessionKey
				};
			}
			if (abortSignal?.aborted) return {
				status: "error",
				error: timeoutErrorMessage()
			};
			if (state.deps.nowMs() - waitStartedAt > maxWaitMs) {
				if (abortSignal?.aborted) return {
					status: "error",
					error: timeoutErrorMessage()
				};
				state.deps.requestHeartbeat({
					source: "cron",
					intent: "immediate",
					reason,
					agentId: job.agentId,
					sessionKey: cronRunSessionKey,
					heartbeat: { target: "last" }
				});
				return {
					status: "ok",
					summary: text,
					sessionKey: cronRunSessionKey
				};
			}
			await waitWithAbort(retryDelayMs);
		}
		if (heartbeatResult.status === "ran") return {
			status: "ok",
			summary: text,
			sessionKey: cronRunSessionKey
		};
		if (heartbeatResult.status === "skipped") return {
			status: "skipped",
			error: heartbeatResult.reason,
			summary: text,
			sessionKey: cronRunSessionKey
		};
		return {
			status: "error",
			error: heartbeatResult.reason,
			summary: text,
			sessionKey: cronRunSessionKey
		};
	}
	if (abortSignal?.aborted) return {
		status: "error",
		error: timeoutErrorMessage()
	};
	state.deps.requestHeartbeat({
		source: "cron",
		intent: job.wakeMode === "now" ? "immediate" : "event",
		reason: `cron:${job.id}`,
		agentId: job.agentId,
		sessionKey: cronRunSessionKey,
		heartbeat: { target: "last" }
	});
	return {
		status: "ok",
		summary: text,
		sessionKey: cronRunSessionKey
	};
}
async function executeDetachedCronJob(state, job, abortSignal, resolveAbortError, options) {
	if (job.payload.kind !== "agentTurn") {
		const error = "isolated job requires payload.kind=agentTurn";
		return {
			status: "skipped",
			error,
			diagnostics: createCronRunDiagnosticsFromError("cron-preflight", error, {
				severity: "warn",
				nowMs: state.deps.nowMs
			})
		};
	}
	if (abortSignal?.aborted) {
		const aborted = resolveAbortError();
		return {
			...aborted,
			diagnostics: createCronRunDiagnosticsFromError("cron-setup", aborted.error, { nowMs: state.deps.nowMs })
		};
	}
	const res = await state.deps.runIsolatedAgentJob({
		job,
		message: job.payload.message,
		abortSignal,
		onExecutionStarted: options?.onExecutionStarted,
		onExecutionPhase: options?.onExecutionPhase
	});
	if (abortSignal?.aborted) {
		const error = abortErrorMessage(abortSignal);
		return {
			status: "error",
			error,
			diagnostics: createCronRunDiagnosticsFromError("cron-setup", error, { nowMs: state.deps.nowMs })
		};
	}
	return {
		status: res.status,
		error: res.error,
		summary: res.summary,
		delivered: res.delivered,
		deliveryAttempted: res.deliveryAttempted,
		delivery: res.delivery,
		sessionId: res.sessionId,
		sessionKey: res.sessionKey,
		diagnostics: res.diagnostics,
		model: res.model,
		provider: res.provider,
		usage: res.usage
	};
}
function emitJobFinished(state, job, result, runAtMs) {
	emit(state, {
		jobId: job.id,
		action: "finished",
		job,
		status: result.status,
		error: result.error,
		summary: result.summary,
		diagnostics: result.diagnostics,
		delivered: job.state.lastDelivered,
		deliveryStatus: job.state.lastDeliveryStatus,
		deliveryError: job.state.lastDeliveryError,
		failureNotificationDelivery: failureNotificationDeliveryFromJobState(job),
		delivery: result.delivery,
		sessionId: result.sessionId,
		sessionKey: result.sessionKey,
		runAtMs,
		durationMs: job.state.lastDurationMs,
		nextRunAtMs: job.state.nextRunAtMs,
		model: result.model,
		provider: result.provider,
		usage: result.usage
	});
}
function wake(state, opts) {
	const text = opts.text.trim();
	if (!text) return { ok: false };
	const sessionKey = opts.sessionKey?.trim() || void 0;
	if (sessionKey && isSubagentSessionKey(sessionKey)) return {
		ok: false,
		reason: "unwakeable-session-key"
	};
	state.deps.enqueueSystemEvent(text, sessionKey ? { sessionKey } : void 0);
	if (opts.mode === "now") state.deps.requestHeartbeat({
		source: "manual",
		intent: "immediate",
		reason: "wake",
		...sessionKey ? { sessionKey } : {}
	});
	else if (sessionKey) state.deps.requestHeartbeat({
		source: "manual",
		intent: "immediate",
		reason: "wake",
		sessionKey
	});
	return { ok: true };
}
function stopTimer(state) {
	if (state.timer) clearTimeout(state.timer);
	state.timer = null;
}
function emit(state, evt) {
	try {
		state.deps.onEvent?.(evt);
	} catch {}
}
//#endregion
//#region src/cron/service/ops.ts
const STARTUP_INTERRUPTED_ERROR = "cron: job interrupted by gateway restart";
function resolveInterruptedStartupFailureNotificationStatus(params) {
	if (params.job.delivery?.bestEffort === true) return "not-requested";
	if (resolveFailureDestination(params.job, params.state.deps.cronConfig?.failureDestination)) return "unknown";
	const primaryPlan = resolveCronDeliveryPlan(params.job);
	return primaryPlan.mode === "announce" && primaryPlan.requested ? "unknown" : "not-requested";
}
function markInterruptedStartupRun(params) {
	const { job, runningAtMs, nowMs } = params;
	const failureNotificationStatus = resolveInterruptedStartupFailureNotificationStatus({
		state: params.state,
		job
	});
	const previousErrors = typeof job.state.consecutiveErrors === "number" && Number.isFinite(job.state.consecutiveErrors) ? Math.max(0, Math.floor(job.state.consecutiveErrors)) : 0;
	params.state.deps.log.warn({
		jobId: job.id,
		runningAtMs
	}, "cron: marking interrupted running job failed on startup");
	job.state.runningAtMs = void 0;
	job.state.lastRunAtMs = runningAtMs;
	job.state.lastRunStatus = "error";
	job.state.lastStatus = "error";
	job.state.lastError = STARTUP_INTERRUPTED_ERROR;
	job.state.lastDurationMs = Math.max(0, nowMs - runningAtMs);
	job.state.consecutiveErrors = previousErrors + 1;
	job.state.lastDelivered = false;
	job.state.lastDeliveryStatus = "unknown";
	job.state.lastDeliveryError = STARTUP_INTERRUPTED_ERROR;
	job.state.lastFailureNotificationDelivered = void 0;
	job.state.lastFailureNotificationDeliveryStatus = failureNotificationStatus;
	job.state.lastFailureNotificationDeliveryError = void 0;
	job.state.nextRunAtMs = void 0;
	job.updatedAtMs = nowMs;
	if (job.schedule.kind === "at") job.enabled = false;
	return {
		jobId: job.id,
		runAtMs: runningAtMs,
		durationMs: job.state.lastDurationMs
	};
}
function mergeManualRunSnapshotAfterReload(params) {
	if (!params.state.store) return;
	if (params.removed) {
		params.state.store.jobs = params.state.store.jobs.filter((job) => job.id !== params.jobId);
		return;
	}
	if (!params.snapshot) return;
	const reloaded = params.state.store.jobs.find((job) => job.id === params.jobId);
	if (!reloaded) return;
	reloaded.enabled = params.snapshot.enabled;
	reloaded.updatedAtMs = params.snapshot.updatedAtMs;
	reloaded.state = params.snapshot.state;
}
async function ensureLoadedForRead(state) {
	await ensureLoaded(state, { skipRecompute: true });
	if (!state.store) return;
	if (recomputeNextRunsForMaintenance(state)) await persist(state);
}
async function start(state) {
	if (!state.deps.cronEnabled) {
		state.deps.log.info({ enabled: false }, "cron: disabled");
		return;
	}
	const interruptedJobIds = /* @__PURE__ */ new Set();
	const interruptedRuns = [];
	let markedAnyInterruptedRun = false;
	await locked(state, async () => {
		await ensureLoaded(state, { skipRecompute: true });
		const jobs = state.store?.jobs ?? [];
		for (const job of jobs) {
			job.state ??= {};
			if (typeof job.state.runningAtMs === "number") {
				const nowMs = state.deps.nowMs();
				const interrupted = markInterruptedStartupRun({
					state,
					job,
					runningAtMs: job.state.runningAtMs,
					nowMs
				});
				interruptedJobIds.add(job.id);
				interruptedRuns.push(interrupted);
				markedAnyInterruptedRun = true;
			}
		}
		if (markedAnyInterruptedRun || jobs.length > 0) await persist(state, markedAnyInterruptedRun ? void 0 : { stateOnly: true });
	});
	await runMissedJobs(state, {
		skipJobIds: interruptedJobIds.size > 0 ? interruptedJobIds : void 0,
		deferAgentTurnJobs: true
	});
	await locked(state, async () => {
		await ensureLoaded(state, { skipRecompute: true });
		if (recomputeNextRunsForMaintenance(state, { recomputeExpired: true })) await persist(state);
		for (const interrupted of interruptedRuns) {
			const job = state.store?.jobs.find((entry) => entry.id === interrupted.jobId);
			emit(state, {
				jobId: interrupted.jobId,
				action: "finished",
				job,
				status: "error",
				error: STARTUP_INTERRUPTED_ERROR,
				delivered: false,
				deliveryStatus: "unknown",
				deliveryError: STARTUP_INTERRUPTED_ERROR,
				failureNotificationDelivery: job ? failureNotificationDeliveryFromJobState(job) : void 0,
				runAtMs: interrupted.runAtMs,
				durationMs: interrupted.durationMs,
				nextRunAtMs: job?.state.nextRunAtMs
			});
		}
		armTimer(state);
		state.deps.log.info({
			enabled: true,
			jobs: state.store?.jobs.length ?? 0,
			nextWakeAtMs: nextWakeAtMs(state) ?? null
		}, "cron: started");
	});
}
function stop(state) {
	stopTimer(state);
}
async function status(state) {
	return await locked(state, async () => {
		await ensureLoadedForRead(state);
		return {
			enabled: state.deps.cronEnabled,
			storePath: state.deps.storePath,
			jobs: state.store?.jobs.length ?? 0,
			nextWakeAtMs: state.deps.cronEnabled ? nextWakeAtMs(state) ?? null : null
		};
	});
}
async function list(state, opts) {
	return await locked(state, async () => {
		await ensureLoadedForRead(state);
		const includeDisabled = opts?.includeDisabled === true;
		return (state.store?.jobs ?? []).filter((j) => includeDisabled || isJobEnabled(j)).toSorted((a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0));
	});
}
async function readJob(state, id) {
	return await locked(state, async () => {
		await ensureLoadedForRead(state);
		return state.store?.jobs.find((job) => job.id === id);
	});
}
function resolveEnabledFilter(opts) {
	if (opts?.enabled === "all" || opts?.enabled === "enabled" || opts?.enabled === "disabled") return opts.enabled;
	return opts?.includeDisabled ? "all" : "enabled";
}
function sortJobs(jobs, sortBy, sortDir) {
	const dir = sortDir === "desc" ? -1 : 1;
	return jobs.toSorted((a, b) => {
		let cmp = 0;
		if (sortBy === "name") {
			const aName = typeof a.name === "string" ? a.name : "";
			const bName = typeof b.name === "string" ? b.name : "";
			cmp = aName.localeCompare(bName, void 0, { sensitivity: "base" });
		} else if (sortBy === "updatedAtMs") cmp = a.updatedAtMs - b.updatedAtMs;
		else {
			const aNext = a.state.nextRunAtMs;
			const bNext = b.state.nextRunAtMs;
			if (typeof aNext === "number" && typeof bNext === "number") cmp = aNext - bNext;
			else if (typeof aNext === "number") cmp = -1;
			else if (typeof bNext === "number") cmp = 1;
			else cmp = 0;
		}
		if (cmp !== 0) return cmp * dir;
		const aId = typeof a.id === "string" ? a.id : "";
		const bId = typeof b.id === "string" ? b.id : "";
		return aId.localeCompare(bId);
	});
}
function resolveEffectiveJobAgentId(job, defaultAgentId) {
	return normalizeOptionalAgentId(job.agentId) ?? normalizeOptionalAgentId(defaultAgentId) ?? "main";
}
async function listPage(state, opts) {
	return await locked(state, async () => {
		await ensureLoadedForRead(state);
		const query = normalizeLowercaseStringOrEmpty(opts?.query);
		const enabledFilter = resolveEnabledFilter(opts);
		const sortBy = opts?.sortBy ?? "nextRunAtMs";
		const sortDir = opts?.sortDir ?? "asc";
		const requestedAgentId = normalizeOptionalAgentId(opts?.agentId);
		const sorted = sortJobs((state.store?.jobs ?? []).filter((job) => {
			if (enabledFilter === "enabled" && !isJobEnabled(job)) return false;
			if (enabledFilter === "disabled" && isJobEnabled(job)) return false;
			if (requestedAgentId && resolveEffectiveJobAgentId(job, state.deps.defaultAgentId) !== requestedAgentId) return false;
			if (!query) return true;
			return normalizeLowercaseStringOrEmpty([
				job.name,
				job.description ?? "",
				job.agentId ?? ""
			].join(" ")).includes(query);
		}), sortBy, sortDir);
		const total = sorted.length;
		const offset = Math.max(0, Math.min(total, Math.floor(opts?.offset ?? 0)));
		const defaultLimit = total === 0 ? 50 : total;
		const limit = Math.max(1, Math.min(200, Math.floor(opts?.limit ?? defaultLimit)));
		const jobs = sorted.slice(offset, offset + limit);
		const nextOffset = offset + jobs.length;
		return {
			jobs,
			total,
			offset,
			limit,
			hasMore: nextOffset < total,
			nextOffset: nextOffset < total ? nextOffset : null
		};
	});
}
async function add(state, input) {
	return await locked(state, async () => {
		warnIfDisabled(state, "add");
		await ensureLoaded(state);
		const job = createJob(state, input);
		state.store?.jobs.push(job);
		recomputeNextRuns(state);
		await persist(state);
		armTimer(state);
		state.deps.log.info({
			jobId: job.id,
			jobName: job.name,
			nextRunAtMs: job.state.nextRunAtMs,
			schedulerNextWakeAtMs: nextWakeAtMs(state) ?? null,
			timerArmed: state.timer !== null,
			cronEnabled: state.deps.cronEnabled
		}, "cron: job added");
		emit(state, {
			jobId: job.id,
			action: "added",
			job,
			nextRunAtMs: job.state.nextRunAtMs
		});
		return job;
	});
}
async function update(state, id, patch) {
	return await locked(state, async () => {
		warnIfDisabled(state, "update");
		await ensureLoaded(state, { skipRecompute: true });
		const job = findJobOrThrow(state, id);
		const now = state.deps.nowMs();
		const nextJob = structuredClone(job);
		applyJobPatch(nextJob, patch, { defaultAgentId: state.deps.defaultAgentId });
		if (nextJob.schedule.kind === "every") {
			const anchor = nextJob.schedule.anchorMs;
			if (typeof anchor !== "number" || !Number.isFinite(anchor)) {
				const fallbackAnchorMs = patch.schedule?.kind === "every" ? now : typeof nextJob.createdAtMs === "number" && Number.isFinite(nextJob.createdAtMs) ? nextJob.createdAtMs : now;
				nextJob.schedule = {
					...nextJob.schedule,
					anchorMs: Math.max(0, Math.floor(fallbackAnchorMs))
				};
			}
		}
		const scheduleChanged = patch.schedule !== void 0;
		const enabledChanged = patch.enabled !== void 0;
		if (scheduleChanged && nextJob.schedule.kind === "cron" && !isJobEnabled(nextJob)) computeJobNextRunAtMs({
			...nextJob,
			enabled: true
		}, now);
		nextJob.updatedAtMs = now;
		if (scheduleChanged || enabledChanged) if (isJobEnabled(nextJob)) nextJob.state.nextRunAtMs = computeJobNextRunAtMs(nextJob, now);
		else {
			nextJob.state.nextRunAtMs = void 0;
			nextJob.state.runningAtMs = void 0;
		}
		else if (isJobEnabled(nextJob) && !hasScheduledNextRunAtMs(nextJob.state.nextRunAtMs)) nextJob.state.nextRunAtMs = computeJobNextRunAtMs(nextJob, now);
		if (state.store) {
			const index = state.store.jobs.findIndex((entry) => entry.id === id);
			if (index >= 0) state.store.jobs[index] = nextJob;
		}
		await persist(state);
		armTimer(state);
		emit(state, {
			jobId: id,
			action: "updated",
			job: nextJob,
			nextRunAtMs: nextJob.state.nextRunAtMs
		});
		return nextJob;
	});
}
async function remove(state, id) {
	return await locked(state, async () => {
		warnIfDisabled(state, "remove");
		await ensureLoaded(state);
		const before = state.store?.jobs.length ?? 0;
		if (!state.store) return {
			ok: false,
			removed: false
		};
		const removedJob = state.store.jobs.find((j) => j.id === id);
		state.store.jobs = state.store.jobs.filter((j) => j.id !== id);
		const removed = (state.store.jobs.length ?? 0) !== before;
		await persist(state);
		armTimer(state);
		if (removed) emit(state, {
			jobId: id,
			action: "removed",
			job: removedJob
		});
		return {
			ok: true,
			removed
		};
	});
}
let nextManualRunId = 1;
async function skipInvalidPersistedManualRun(params) {
	const endedAt = params.state.deps.nowMs();
	const errorText = normalizeCronRunErrorText(params.error);
	const diagnostics = createCronRunDiagnosticsFromError("cron-preflight", errorText, {
		severity: "warn",
		nowMs: params.state.deps.nowMs
	});
	const shouldDelete = applyJobResult(params.state, params.job, {
		status: "skipped",
		error: errorText,
		diagnostics,
		startedAt: endedAt,
		endedAt
	}, { preserveSchedule: params.mode === "force" });
	emit(params.state, {
		jobId: params.job.id,
		action: "finished",
		status: "skipped",
		error: errorText,
		diagnostics,
		runAtMs: endedAt,
		durationMs: params.job.state.lastDurationMs,
		nextRunAtMs: params.job.state.nextRunAtMs,
		deliveryStatus: params.job.state.lastDeliveryStatus,
		deliveryError: params.job.state.lastDeliveryError,
		failureNotificationDelivery: failureNotificationDeliveryFromJobState(params.job)
	});
	if (shouldDelete && params.state.store) {
		params.state.store.jobs = params.state.store.jobs.filter((entry) => entry.id !== params.job.id);
		emit(params.state, {
			jobId: params.job.id,
			action: "removed"
		});
	}
	recomputeNextRunsForMaintenance(params.state, { recomputeExpired: true });
	await persist(params.state);
	armTimer(params.state);
}
function tryCreateManualTaskRun(params) {
	const runId = createCronExecutionId(params.job.id, params.startedAt);
	try {
		createRunningTaskRun({
			runtime: "cron",
			sourceId: params.job.id,
			ownerKey: "",
			scopeKind: "system",
			childSessionKey: params.job.sessionKey,
			agentId: params.job.agentId,
			runId,
			label: params.job.name,
			task: params.job.name || params.job.id,
			deliveryStatus: "not_applicable",
			notifyPolicy: "silent",
			startedAt: params.startedAt,
			lastEventAt: params.startedAt
		});
		return runId;
	} catch (error) {
		params.state.deps.log.warn({
			jobId: params.job.id,
			error
		}, "cron: failed to create task ledger record");
		return;
	}
}
function tryFinishManualTaskRun(state, params) {
	if (!params.taskRunId) return;
	try {
		if (params.coreResult.status === "ok" || params.coreResult.status === "skipped") {
			completeTaskRunByRunId({
				runId: params.taskRunId,
				runtime: "cron",
				endedAt: params.endedAt,
				lastEventAt: params.endedAt,
				terminalSummary: params.coreResult.summary ?? void 0
			});
			return;
		}
		failTaskRunByRunId({
			runId: params.taskRunId,
			runtime: "cron",
			status: normalizeCronRunErrorText(params.coreResult.error) === "cron: job execution timed out" ? "timed_out" : "failed",
			endedAt: params.endedAt,
			lastEventAt: params.endedAt,
			error: params.coreResult.status === "error" ? normalizeCronRunErrorText(params.coreResult.error) : void 0,
			terminalSummary: params.coreResult.summary ?? void 0
		});
	} catch (error) {
		state.deps.log.warn({
			runId: params.taskRunId,
			jobStatus: params.coreResult.status,
			error
		}, "cron: failed to update task ledger record");
	}
}
async function inspectManualRunPreflight(state, id, mode) {
	return await locked(state, async () => {
		warnIfDisabled(state, "run");
		await ensureLoaded(state, { skipRecompute: true });
		recomputeNextRunsForMaintenance(state);
		const job = findJobOrThrow(state, id);
		try {
			assertSupportedJobSpec(job);
		} catch (error) {
			await skipInvalidPersistedManualRun({
				state,
				job,
				mode,
				error
			});
			return {
				ok: true,
				ran: false,
				reason: "invalid-spec"
			};
		}
		if (typeof job.state.runningAtMs === "number") return {
			ok: true,
			ran: false,
			reason: "already-running"
		};
		const now = state.deps.nowMs();
		if (!isJobDue(job, now, { forced: mode === "force" })) return {
			ok: true,
			ran: false,
			reason: "not-due"
		};
		return {
			ok: true,
			runnable: true,
			job,
			now
		};
	});
}
async function inspectManualRunDisposition(state, id, mode) {
	const result = await inspectManualRunPreflight(state, id, mode);
	if (!result.ok) return result;
	if ("reason" in result) return result;
	return {
		ok: true,
		runnable: true
	};
}
async function prepareManualRun(state, id, mode, opts) {
	const preflight = await inspectManualRunPreflight(state, id, mode);
	if (!preflight.ok) return preflight;
	if ("reason" in preflight) return {
		ok: true,
		ran: false,
		reason: preflight.reason
	};
	return await locked(state, async () => {
		const job = findJobOrThrow(state, id);
		if (typeof job.state.runningAtMs === "number") return {
			ok: true,
			ran: false,
			reason: "already-running"
		};
		job.state.runningAtMs = preflight.now;
		job.state.lastError = void 0;
		await persist(state);
		emit(state, {
			jobId: job.id,
			action: "started",
			job,
			runAtMs: preflight.now
		});
		const taskRunId = tryCreateManualTaskRun({
			state,
			job,
			startedAt: preflight.now
		});
		markCronJobActive(job.id);
		const executionJob = structuredClone(job);
		return {
			ok: true,
			ran: true,
			jobId: job.id,
			runId: opts?.runId ?? taskRunId,
			taskRunId,
			startedAt: preflight.now,
			executionJob
		};
	});
}
async function finishPreparedManualRun(state, prepared, mode) {
	const executionJob = prepared.executionJob;
	const startedAt = prepared.startedAt;
	const jobId = prepared.jobId;
	const taskRunId = prepared.taskRunId;
	const runId = prepared.runId;
	try {
		let coreResult;
		try {
			coreResult = await executeJobCoreWithTimeout(state, executionJob);
		} catch (err) {
			coreResult = {
				status: "error",
				error: normalizeCronRunErrorText(err)
			};
		}
		const endedAt = state.deps.nowMs();
		tryFinishManualTaskRun(state, {
			taskRunId,
			coreResult,
			endedAt
		});
		await locked(state, async () => {
			await ensureLoaded(state, { skipRecompute: true });
			const job = state.store?.jobs.find((entry) => entry.id === jobId);
			if (!job) return;
			const shouldDelete = applyJobResult(state, job, {
				status: coreResult.status,
				error: coreResult.error,
				diagnostics: coreResult.diagnostics,
				delivered: coreResult.delivered,
				startedAt,
				endedAt
			}, { preserveSchedule: mode === "force" });
			emit(state, {
				jobId: job.id,
				action: "finished",
				job,
				status: coreResult.status,
				error: coreResult.error,
				summary: coreResult.summary,
				diagnostics: coreResult.diagnostics,
				delivered: job.state.lastDelivered,
				deliveryStatus: job.state.lastDeliveryStatus,
				deliveryError: job.state.lastDeliveryError,
				failureNotificationDelivery: failureNotificationDeliveryFromJobState(job),
				delivery: coreResult.delivery,
				sessionId: coreResult.sessionId,
				sessionKey: coreResult.sessionKey,
				runId,
				runAtMs: startedAt,
				durationMs: job.state.lastDurationMs,
				nextRunAtMs: job.state.nextRunAtMs,
				model: coreResult.model,
				provider: coreResult.provider,
				usage: coreResult.usage
			});
			if (shouldDelete && state.store) {
				state.store.jobs = state.store.jobs.filter((entry) => entry.id !== job.id);
				emit(state, {
					jobId: job.id,
					action: "removed",
					job
				});
			}
			const postRunSnapshot = shouldDelete ? null : {
				enabled: job.enabled,
				updatedAtMs: job.updatedAtMs,
				state: structuredClone(job.state)
			};
			const postRunRemoved = shouldDelete;
			await ensureLoaded(state, {
				forceReload: true,
				skipRecompute: true
			});
			mergeManualRunSnapshotAfterReload({
				state,
				jobId,
				snapshot: postRunSnapshot,
				removed: postRunRemoved
			});
			recomputeNextRunsForMaintenance(state, { recomputeExpired: true });
			await persist(state);
			armTimer(state);
		});
	} finally {
		clearCronJobActive(jobId);
	}
}
async function run(state, id, mode, opts) {
	const prepared = await prepareManualRun(state, id, mode, opts);
	if (!prepared.ok || !prepared.ran) return prepared;
	await finishPreparedManualRun(state, prepared, mode);
	return {
		ok: true,
		ran: true
	};
}
async function enqueueRun(state, id, mode) {
	const disposition = await inspectManualRunDisposition(state, id, mode);
	if (!disposition.ok || !("runnable" in disposition && disposition.runnable)) return disposition;
	const runId = `manual:${id}:${state.deps.nowMs()}:${nextManualRunId++}`;
	enqueueCommandInLane("cron", async () => {
		const result = await run(state, id, mode, { runId });
		if (result.ok && "ran" in result && !result.ran) state.deps.log.info({
			jobId: id,
			runId,
			reason: result.reason
		}, "cron: queued manual run skipped before execution");
		return result;
	}, {
		warnAfterMs: 5e3,
		onWait: (waitMs, queuedAhead) => {
			state.deps.log.warn({
				jobId: id,
				runId,
				waitMs,
				queuedAhead
			}, "cron: queued manual run waiting for an execution slot");
		}
	}).catch((err) => {
		state.deps.log.error({
			jobId: id,
			runId,
			err: String(err)
		}, "cron: queued manual run background execution failed");
	});
	return {
		ok: true,
		enqueued: true,
		runId
	};
}
function wakeNow(state, opts) {
	return wake(state, opts);
}
//#endregion
//#region src/cron/service/state.ts
function createCronServiceState(deps) {
	return {
		deps: {
			...deps,
			nowMs: deps.nowMs ?? (() => Date.now())
		},
		store: null,
		timer: null,
		running: false,
		op: Promise.resolve(),
		warnedDisabled: false,
		warnedMissingSessionTargetJobIds: /* @__PURE__ */ new Set(),
		warnedInvalidPersistedJobKeys: /* @__PURE__ */ new Set(),
		storeLoadedAtMs: null,
		storeFileMtimeMs: null
	};
}
//#endregion
//#region src/cron/service.ts
var CronService = class {
	constructor(deps) {
		this.state = createCronServiceState(deps);
	}
	async start() {
		await start(this.state);
	}
	stop() {
		stop(this.state);
	}
	async status() {
		return await status(this.state);
	}
	async list(opts) {
		return await list(this.state, opts);
	}
	async listPage(opts) {
		return await listPage(this.state, opts);
	}
	async add(input) {
		return await add(this.state, input);
	}
	async update(id, patch) {
		return await update(this.state, id, patch);
	}
	async remove(id) {
		return await remove(this.state, id);
	}
	async run(id, mode) {
		return await run(this.state, id, mode);
	}
	async enqueueRun(id, mode) {
		const result = await enqueueRun(this.state, id, mode);
		if (result.ok && "runnable" in result) throw new Error("cron enqueueRun returned unresolved runnable disposition");
		return result;
	}
	getJob(id) {
		return this.state.store?.jobs.find((job) => job.id === id);
	}
	async readJob(id) {
		return await readJob(this.state, id);
	}
	getDefaultAgentId() {
		return this.state.deps.defaultAgentId;
	}
	wake(opts) {
		return wakeNow(this.state, opts);
	}
};
//#endregion
//#region src/cron/delivery.ts
const FAILURE_NOTIFICATION_TIMEOUT_MS = 3e4;
const cronDeliveryLogger = getChildLogger({ subsystem: "cron-delivery" });
async function resolveCronAnnounceDelivery(params) {
	const resolvedTarget = await resolveDeliveryTarget(params.cfg, params.agentId, {
		channel: params.target.channel,
		to: params.target.to,
		accountId: params.target.accountId,
		sessionKey: params.target.sessionKey
	});
	if (!resolvedTarget.ok) return {
		ok: false,
		error: resolvedTarget.error
	};
	const identity = resolveAgentOutboundIdentity(params.cfg, params.agentId);
	return {
		ok: true,
		resolvedTarget,
		session: buildOutboundSessionContext({
			cfg: params.cfg,
			agentId: params.agentId,
			sessionKey: resolveCronNotificationSessionKey({
				jobId: params.jobId,
				sessionKey: params.target.sessionKey
			})
		}),
		identity
	};
}
async function deliverCronAnnouncePayload(params) {
	const send = await sendDurableMessageBatch({
		cfg: params.cfg,
		channel: params.delivery.resolvedTarget.channel,
		to: params.delivery.resolvedTarget.to,
		accountId: params.delivery.resolvedTarget.accountId,
		threadId: params.delivery.resolvedTarget.threadId,
		payloads: [{ text: params.message }],
		session: params.delivery.session,
		identity: params.delivery.identity,
		bestEffort: false,
		deps: createOutboundSendDeps(params.deps),
		signal: params.abortSignal
	});
	if (send.status === "failed" || send.status === "partial_failed") throw send.error;
}
async function sendCronAnnouncePayloadStrict(params) {
	const delivery = await resolveCronAnnounceDelivery(params);
	if (!delivery.ok) throw delivery.error;
	await deliverCronAnnouncePayload({
		deps: params.deps,
		cfg: params.cfg,
		delivery,
		message: params.message,
		abortSignal: params.abortSignal
	});
}
async function sendFailureNotificationAnnounce(deps, cfg, agentId, jobId, target, message) {
	const delivery = await resolveCronAnnounceDelivery({
		cfg,
		agentId,
		jobId,
		target
	});
	if (!delivery.ok) {
		cronDeliveryLogger.warn({ error: delivery.error.message }, "cron: failed to resolve failure destination target");
		return;
	}
	const abortController = new AbortController();
	const timeout = setTimeout(() => {
		abortController.abort();
	}, FAILURE_NOTIFICATION_TIMEOUT_MS);
	try {
		await deliverCronAnnouncePayload({
			deps,
			cfg,
			delivery,
			message,
			abortSignal: abortController.signal
		});
	} catch (err) {
		cronDeliveryLogger.warn({
			err: formatErrorMessage(err),
			channel: delivery.resolvedTarget.channel,
			to: delivery.resolvedTarget.to
		}, "cron: failure destination announce failed");
	} finally {
		clearTimeout(timeout);
	}
}
//#endregion
//#region src/gateway/server-cron-notifications.ts
const CRON_WEBHOOK_TIMEOUT_MS = 1e4;
function redactWebhookUrl(url) {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		return "<invalid-webhook-url>";
	}
}
function resolveCronWebhookTarget(params) {
	if (normalizeOptionalLowercaseString(params.delivery?.mode) === "webhook") {
		const url = normalizeHttpWebhookUrl(params.delivery?.to);
		return url ? {
			url,
			source: "delivery"
		} : null;
	}
	if (params.legacyNotify) {
		const legacyUrl = normalizeHttpWebhookUrl(params.legacyWebhook);
		if (legacyUrl) return {
			url: legacyUrl,
			source: "legacy"
		};
	}
	return null;
}
function buildCronWebhookHeaders(webhookToken) {
	const headers = { "Content-Type": "application/json" };
	if (webhookToken) headers.Authorization = `Bearer ${webhookToken}`;
	return headers;
}
async function postCronWebhook(params) {
	const abortController = new AbortController();
	const timeout = setTimeout(() => {
		abortController.abort();
	}, CRON_WEBHOOK_TIMEOUT_MS);
	try {
		await (await fetchWithSsrFGuard({
			url: params.webhookUrl,
			init: {
				method: "POST",
				headers: buildCronWebhookHeaders(params.webhookToken),
				body: JSON.stringify(params.payload),
				signal: abortController.signal
			}
		})).release();
	} catch (err) {
		if (err instanceof SsrFBlockedError) params.logger.warn({
			...params.logContext,
			reason: formatErrorMessage(err),
			webhookUrl: redactWebhookUrl(params.webhookUrl)
		}, params.blockedLog);
		else params.logger.warn({
			...params.logContext,
			err: formatErrorMessage(err),
			webhookUrl: redactWebhookUrl(params.webhookUrl)
		}, params.failedLog);
	} finally {
		clearTimeout(timeout);
	}
}
async function sendGatewayCronFailureAlert(params) {
	const { agentId, cfg: runtimeConfig } = params.resolveCronAgent(params.job.agentId);
	const webhookToken = normalizeOptionalString(params.webhookToken);
	if (params.mode === "webhook" && !params.to) {
		params.logger.warn({ jobId: params.job.id }, "cron: failure alert webhook mode requires URL, skipping");
		return;
	}
	if (params.mode === "webhook" && params.to) {
		const webhookUrl = normalizeHttpWebhookUrl(params.to);
		if (webhookUrl) await postCronWebhook({
			webhookUrl,
			webhookToken,
			payload: {
				jobId: params.job.id,
				jobName: params.job.name,
				message: params.text
			},
			logContext: { jobId: params.job.id },
			blockedLog: "cron: failure alert webhook blocked by SSRF guard",
			failedLog: "cron: failure alert webhook failed",
			logger: params.logger
		});
		else params.logger.warn({
			jobId: params.job.id,
			webhookUrl: redactWebhookUrl(params.to)
		}, "cron: failure alert webhook URL is invalid, skipping");
		return;
	}
	const abortController = new AbortController();
	await sendCronAnnouncePayloadStrict({
		deps: params.deps,
		cfg: runtimeConfig,
		agentId,
		jobId: params.job.id,
		target: {
			channel: params.channel,
			to: params.to,
			accountId: params.accountId,
			sessionKey: resolveCronDeliverySessionKey(params.job)
		},
		message: params.text,
		abortSignal: abortController.signal
	});
}
function dispatchGatewayCronFinishedNotifications(params) {
	const webhookToken = normalizeOptionalString(params.webhookToken);
	const legacyWebhook = normalizeOptionalString(params.legacyWebhook);
	const legacyNotify = params.job?.notify === true;
	const webhookTarget = resolveCronWebhookTarget({
		delivery: params.job?.delivery && typeof params.job.delivery.mode === "string" ? {
			mode: params.job.delivery.mode,
			to: params.job.delivery.to
		} : void 0,
		legacyNotify,
		legacyWebhook
	});
	if (!webhookTarget && params.job?.delivery?.mode === "webhook") params.logger.warn({
		jobId: params.evt.jobId,
		deliveryTo: params.job.delivery.to
	}, "cron: skipped webhook delivery, delivery.to must be a valid http(s) URL");
	if (webhookTarget?.source === "legacy" && !params.warnedLegacyWebhookJobs.has(params.evt.jobId)) {
		params.warnedLegacyWebhookJobs.add(params.evt.jobId);
		params.logger.warn({
			jobId: params.evt.jobId,
			legacyWebhook: redactWebhookUrl(webhookTarget.url)
		}, "cron: deprecated notify+cron.webhook fallback in use, migrate to delivery.mode=webhook with delivery.to");
	}
	if (webhookTarget && params.evt.summary) (async () => {
		await postCronWebhook({
			webhookUrl: webhookTarget.url,
			webhookToken,
			payload: params.evt,
			logContext: { jobId: params.evt.jobId },
			blockedLog: "cron: webhook delivery blocked by SSRF guard",
			failedLog: "cron: webhook delivery failed",
			logger: params.logger
		});
	})();
	dispatchCronFailureDestinationNotifications({
		evt: params.evt,
		job: params.job,
		deps: params.deps,
		logger: params.logger,
		resolveCronAgent: params.resolveCronAgent,
		webhookToken,
		globalFailureDestination: params.globalFailureDestination
	});
}
function dispatchCronFailureDestinationNotifications(params) {
	if (params.evt.status !== "error" || !params.job || params.job.delivery?.bestEffort === true) return;
	const failureMessage = `Cron job "${params.job.name}" failed: ${params.evt.error ?? "unknown error"}`;
	const failureDest = resolveFailureDestination(params.job, params.globalFailureDestination);
	const deliverySessionKey = resolveCronDeliverySessionKey(params.job);
	if (failureDest) {
		const failurePayload = {
			jobId: params.job.id,
			jobName: params.job.name,
			message: failureMessage,
			status: params.evt.status,
			error: params.evt.error,
			runAtMs: params.evt.runAtMs,
			durationMs: params.evt.durationMs,
			nextRunAtMs: params.evt.nextRunAtMs
		};
		if (failureDest.mode === "webhook" && failureDest.to) {
			const webhookUrl = normalizeHttpWebhookUrl(failureDest.to);
			if (webhookUrl) (async () => {
				await postCronWebhook({
					webhookUrl,
					webhookToken: params.webhookToken,
					payload: failurePayload,
					logContext: { jobId: params.evt.jobId },
					blockedLog: "cron: failure destination webhook blocked by SSRF guard",
					failedLog: "cron: failure destination webhook failed",
					logger: params.logger
				});
			})();
			else params.logger.warn({
				jobId: params.evt.jobId,
				webhookUrl: redactWebhookUrl(failureDest.to)
			}, "cron: failure destination webhook URL is invalid, skipping");
			return;
		}
		if (failureDest.mode === "announce") {
			const { agentId, cfg: runtimeConfig } = params.resolveCronAgent(params.job.agentId);
			sendFailureNotificationAnnounce(params.deps, runtimeConfig, agentId, params.job.id, {
				channel: failureDest.channel,
				to: failureDest.to,
				accountId: failureDest.accountId,
				sessionKey: deliverySessionKey
			}, `⚠️ ${failureMessage}`);
		}
		return;
	}
	const primaryPlan = resolveCronDeliveryPlan(params.job);
	if (primaryPlan.mode !== "announce" || !primaryPlan.requested) return;
	const { agentId, cfg: runtimeConfig } = params.resolveCronAgent(params.job.agentId);
	sendFailureNotificationAnnounce(params.deps, runtimeConfig, agentId, params.job.id, {
		channel: primaryPlan.channel,
		to: primaryPlan.to,
		accountId: primaryPlan.accountId,
		sessionKey: deliverySessionKey
	}, `⚠️ ${failureMessage}`);
}
//#endregion
//#region src/gateway/server-cron.ts
/** Pick only the keys whose values are not `undefined` from an object. */
function pickDefined(obj, keys) {
	const result = {};
	for (const k of keys) if (obj[k] !== void 0) result[k] = obj[k];
	return result;
}
function omitExplicitHeartbeatDestination(heartbeat) {
	if (!heartbeat) return;
	return {
		...heartbeat,
		to: void 0,
		accountId: void 0
	};
}
function sanitizeCronHeartbeatOverride(heartbeat) {
	return heartbeat?.target === "last" ? omitExplicitHeartbeatDestination(heartbeat) : heartbeat;
}
/** Map internal CronJob to the public plugin SDK shape. */
function toPluginCronJob(job) {
	return {
		id: job.id,
		agentId: job.agentId,
		name: job.name,
		description: job.description,
		enabled: job.enabled,
		schedule: job.schedule ? structuredClone(job.schedule) : void 0,
		sessionTarget: job.sessionTarget,
		wakeMode: job.wakeMode,
		payload: job.payload ? structuredClone(job.payload) : void 0,
		state: {
			nextRunAtMs: job.state.nextRunAtMs,
			runningAtMs: job.state.runningAtMs,
			lastRunAtMs: job.state.lastRunAtMs,
			lastRunStatus: job.state.lastRunStatus,
			lastError: job.state.lastError,
			lastDurationMs: job.state.lastDurationMs,
			lastDelivered: job.state.lastDelivered,
			lastDeliveryStatus: job.state.lastDeliveryStatus,
			lastDeliveryError: job.state.lastDeliveryError,
			lastFailureNotificationDelivered: job.state.lastFailureNotificationDelivered,
			lastFailureNotificationDeliveryStatus: job.state.lastFailureNotificationDeliveryStatus,
			lastFailureNotificationDeliveryError: job.state.lastFailureNotificationDeliveryError
		},
		createdAtMs: job.createdAtMs,
		updatedAtMs: job.updatedAtMs
	};
}
function buildGatewayCronService(params) {
	const cronLogger = getChildLogger({ module: "cron" });
	const storePath = resolveCronStorePath(params.cfg.cron?.store);
	const cronEnabled = process.env.OPENCLAW_SKIP_CRON !== "1" && params.cfg.cron?.enabled !== false;
	const findAgentEntry = (cfg, agentId) => Array.isArray(cfg.agents?.list) ? cfg.agents.list.find((entry) => entry && typeof entry.id === "string" && normalizeAgentId(entry.id) === agentId) : void 0;
	const hasConfiguredAgent = (cfg, agentId) => Boolean(findAgentEntry(cfg, agentId));
	const mergeRuntimeAgentConfig = (runtimeConfig, requestedAgentId) => {
		if (hasConfiguredAgent(runtimeConfig, requestedAgentId)) return runtimeConfig;
		const fallbackAgentEntry = findAgentEntry(params.cfg, requestedAgentId);
		if (!fallbackAgentEntry) return runtimeConfig;
		const startupAgents = params.cfg.agents;
		const runtimeAgents = runtimeConfig.agents;
		return {
			...runtimeConfig,
			agents: {
				...startupAgents,
				...runtimeAgents,
				defaults: {
					...startupAgents?.defaults,
					...runtimeAgents?.defaults
				},
				list: [...runtimeAgents?.list ?? [], fallbackAgentEntry]
			}
		};
	};
	const resolveCronAgent = (requested) => {
		const runtimeConfig = getRuntimeConfig();
		const normalized = typeof requested === "string" && requested.trim() ? normalizeAgentId(requested) : void 0;
		const effectiveConfig = normalized !== void 0 ? mergeRuntimeAgentConfig(runtimeConfig, normalized) : runtimeConfig;
		return {
			agentId: normalized !== void 0 && hasConfiguredAgent(effectiveConfig, normalized) ? normalized : resolveDefaultAgentId(effectiveConfig),
			cfg: effectiveConfig
		};
	};
	const resolveCronSessionKey = (params) => {
		const requested = params.requestedSessionKey?.trim();
		if (!requested) return resolveAgentMainSessionKey({
			cfg: params.runtimeConfig,
			agentId: params.agentId
		});
		const candidate = toAgentStoreSessionKey({
			agentId: params.agentId,
			requestKey: requested,
			mainKey: params.runtimeConfig.session?.mainKey
		});
		const canonical = canonicalizeMainSessionAlias({
			cfg: params.runtimeConfig,
			agentId: params.agentId,
			sessionKey: candidate
		});
		if (canonical !== "global") {
			if (normalizeAgentId(resolveAgentIdFromSessionKey(canonical)) !== normalizeAgentId(params.agentId)) return resolveAgentMainSessionKey({
				cfg: params.runtimeConfig,
				agentId: params.agentId
			});
		}
		return resolveMainScopedEventSessionKey({
			cfg: params.runtimeConfig,
			sessionKey: canonical,
			agentId: params.agentId
		}) ?? canonical;
	};
	const resolveCronTarget = (opts) => {
		const requestedAgentId = typeof opts?.agentId === "string" && opts.agentId.trim() ? normalizeAgentId(opts.agentId) : void 0;
		const requestedSessionKey = typeof opts?.sessionKey === "string" && opts.sessionKey.trim() ? opts.sessionKey : void 0;
		if (opts?.preserveUntargeted && !requestedAgentId && !requestedSessionKey) return {
			runtimeConfig: getRuntimeConfig(),
			agentId: void 0,
			sessionKey: void 0
		};
		const derivedAgentId = requestedSessionKey && parseAgentSessionKey(requestedSessionKey) ? resolveAgentIdFromSessionKey(requestedSessionKey) : void 0;
		const { agentId: resolvedAgentId, cfg: runtimeConfig } = resolveCronAgent(requestedAgentId ?? derivedAgentId);
		const agentId = resolvedAgentId || void 0;
		const resolvedSessionKey = agentId ? resolveCronSessionKey({
			runtimeConfig,
			agentId,
			requestedSessionKey
		}) : void 0;
		return {
			runtimeConfig,
			agentId,
			sessionKey: resolvedSessionKey && runtimeConfig.session?.scope === "global" ? resolveEventSessionKey(resolvedSessionKey, runtimeConfig.session?.mainKey, runtimeConfig.session?.scope) : resolvedSessionKey
		};
	};
	const resolveCronHeartbeatOverride = (params) => {
		if (!params.heartbeat) return;
		const agentEntry = params.agentId !== void 0 ? findAgentEntry(params.runtimeConfig, params.agentId) : void 0;
		const agentHeartbeat = agentEntry && typeof agentEntry === "object" ? agentEntry.heartbeat : void 0;
		return sanitizeCronHeartbeatOverride({
			...params.runtimeConfig.agents?.defaults?.heartbeat,
			...agentHeartbeat,
			...params.heartbeat
		});
	};
	const defaultAgentId = resolveDefaultAgentId(params.cfg);
	const runLogPrune = resolveCronRunLogPruneOptions(params.cfg.cron?.runLog);
	const resolveSessionStorePath = (agentId) => resolveStorePath(params.cfg.session?.store, { agentId: agentId ?? defaultAgentId });
	const sessionStorePath = resolveSessionStorePath(defaultAgentId);
	const warnedLegacyWebhookJobs = /* @__PURE__ */ new Set();
	const runCronChangedHook = (evt) => {
		const hookRunner = getGlobalHookRunner();
		if (!hookRunner?.hasHooks("cron_changed")) return;
		const hookCtx = {
			config: getRuntimeConfig(),
			getCron: () => cron
		};
		hookRunner.runCronChanged(evt, hookCtx).catch((err) => {
			cronLogger.warn({
				err: formatErrorMessage(err),
				jobId: evt.jobId
			}, "cron_changed hook failed");
		});
	};
	const cron = new CronService({
		storePath,
		cronEnabled,
		cronConfig: params.cfg.cron,
		defaultAgentId,
		resolveSessionStorePath,
		sessionStorePath,
		enqueueSystemEvent: (text, opts) => {
			const { sessionKey } = resolveCronTarget(opts);
			if (!sessionKey) throw new Error("Cron system event target did not resolve a session key.");
			enqueueSystemEvent(text, {
				sessionKey,
				contextKey: opts?.contextKey,
				deliveryContext: opts?.deliveryContext
			});
		},
		requestHeartbeat: (opts) => {
			const { agentId, sessionKey } = resolveCronTarget({
				...opts,
				preserveUntargeted: true
			});
			requestHeartbeat({
				source: opts?.source ?? "cron",
				intent: opts?.intent ?? "event",
				reason: opts?.reason,
				agentId,
				sessionKey,
				heartbeat: sanitizeCronHeartbeatOverride(opts?.heartbeat)
			});
		},
		runHeartbeatOnce: async (opts) => {
			const { runtimeConfig, agentId, sessionKey } = resolveCronTarget({
				...opts,
				preserveUntargeted: true
			});
			return await runHeartbeatOnce({
				cfg: runtimeConfig,
				source: opts?.source ?? "cron",
				intent: opts?.intent ?? "event",
				reason: opts?.reason,
				agentId,
				sessionKey,
				heartbeat: resolveCronHeartbeatOverride({
					runtimeConfig,
					agentId,
					heartbeat: opts?.heartbeat
				}),
				deps: {
					...params.deps,
					runtime: defaultRuntime
				}
			});
		},
		runIsolatedAgentJob: async ({ job, message, abortSignal, onExecutionStarted, onExecutionPhase }) => {
			const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
			const sessionKey = resolveCronSessionTargetSessionKey(job.sessionTarget) ?? `cron:${job.id}`;
			try {
				return await runCronIsolatedAgentTurn({
					cfg: runtimeConfig,
					deps: params.deps,
					job,
					message,
					abortSignal,
					onExecutionStarted,
					onExecutionPhase,
					agentId,
					sessionKey,
					lane: "cron"
				});
			} finally {
				await cleanupBrowserSessionsForLifecycleEnd({
					sessionKeys: [sessionKey],
					onWarn: (msg) => cronLogger.warn({ jobId: job.id }, msg)
				});
			}
		},
		cleanupTimedOutAgentRun: async ({ job, execution }) => {
			if (!execution?.sessionId) return;
			const result = await abortAndDrainEmbeddedPiRun({
				sessionId: execution.sessionId,
				sessionKey: execution.sessionKey,
				settleMs: 15e3,
				forceClear: true,
				reason: "cron_timeout"
			});
			cronLogger.warn({
				jobId: job.id,
				sessionId: execution.sessionId,
				sessionKey: execution.sessionKey,
				aborted: result.aborted,
				drained: result.drained,
				forceCleared: result.forceCleared
			}, "cron: cleaned up timed-out agent run");
		},
		sendCronFailureAlert: async ({ job, text, channel, to, mode, accountId }) => await sendGatewayCronFailureAlert({
			deps: params.deps,
			logger: cronLogger,
			resolveCronAgent,
			webhookToken: params.cfg.cron?.webhookToken,
			job,
			text,
			channel,
			to,
			mode,
			accountId
		}),
		log: getChildLogger({
			module: "cron",
			storePath
		}),
		onEvent: (evt) => {
			params.broadcast("cron", evt, { dropIfSlow: true });
			const jobSnapshot = evt.job ?? cron.getJob(evt.jobId);
			const pluginJob = jobSnapshot ? toPluginCronJob(jobSnapshot) : void 0;
			runCronChangedHook({
				action: evt.action,
				jobId: evt.jobId,
				...pluginJob ? { job: pluginJob } : {},
				sessionTarget: jobSnapshot?.sessionTarget,
				agentId: jobSnapshot?.agentId,
				...pickDefined(evt, [
					"runAtMs",
					"durationMs",
					"status",
					"error",
					"summary",
					"delivered",
					"deliveryStatus",
					"deliveryError",
					"sessionId",
					"sessionKey",
					"runId",
					"nextRunAtMs",
					"model",
					"provider"
				])
			});
			if (evt.action === "finished") {
				dispatchGatewayCronFinishedNotifications({
					evt,
					job: evt.job ?? cron.getJob(evt.jobId),
					deps: params.deps,
					logger: cronLogger,
					resolveCronAgent,
					webhookToken: params.cfg.cron?.webhookToken,
					legacyWebhook: params.cfg.cron?.webhook,
					globalFailureDestination: params.cfg.cron?.failureDestination,
					warnedLegacyWebhookJobs
				});
				const logPath = resolveCronRunLogPath({
					storePath,
					jobId: evt.jobId
				});
				appendCronRunLog(logPath, {
					ts: Date.now(),
					jobId: evt.jobId,
					action: "finished",
					status: evt.status,
					error: evt.error,
					summary: evt.summary,
					diagnostics: evt.diagnostics,
					delivered: evt.delivered,
					deliveryStatus: evt.deliveryStatus,
					deliveryError: evt.deliveryError,
					failureNotificationDelivery: evt.failureNotificationDelivery,
					delivery: evt.delivery,
					sessionId: evt.sessionId,
					sessionKey: evt.sessionKey,
					runId: evt.runId,
					runAtMs: evt.runAtMs,
					durationMs: evt.durationMs,
					nextRunAtMs: evt.nextRunAtMs,
					model: evt.model,
					provider: evt.provider,
					usage: evt.usage
				}, runLogPrune).catch((err) => {
					cronLogger.warn({
						err: String(err),
						logPath
					}, "cron: run log append failed");
				});
			}
		}
	});
	return {
		cron,
		storePath,
		cronEnabled
	};
}
//#endregion
export { buildGatewayCronService as t };
