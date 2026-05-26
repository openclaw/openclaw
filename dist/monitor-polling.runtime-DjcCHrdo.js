import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { c as readErrorName, i as formatErrorMessage, t as collectErrorGraphCandidates } from "./errors-b3ZrCRlt.js";
import { n as sleepWithAbort, t as computeBackoff } from "./backoff-BQ4uO4hX.js";
import { r as formatDurationPrecise } from "./format-duration-BrZ-AaEJ.js";
import "./error-runtime-DGHc7DZw.js";
import "./runtime-env-BtvWnLRh.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { a as isRecoverableTelegramNetworkError, t as TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_MS } from "./request-timeouts-CnvnuqEE.js";
import { a as listTelegramSpooledUpdateClaims, c as releaseTelegramSpooledUpdateClaim, i as isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess, l as resolveTelegramIngressSpoolDir, n as deleteTelegramSpooledUpdate, o as listTelegramSpooledUpdates, r as failTelegramSpooledUpdateClaim, s as recoverStaleTelegramSpooledUpdateClaims, t as claimTelegramSpooledUpdate } from "./telegram-ingress-spool-mviSjVIC.js";
import { t as drainPendingDeliveries } from "./delivery-queue-runtime-CvszPvAz.js";
import "./ssrf-runtime-Be2o3zD7.js";
import { n as createTransportActivityStatusPatch, t as createConnectedChannelStatusPatch } from "./gateway-runtime-HxuTzDuS.js";
import { n as readTelegramUpdateOffset, r as writeTelegramUpdateOffset, t as deleteTelegramUpdateOffset } from "./update-offset-store-BL6j2jKn.js";
import { O as withTelegramApiErrorLogging } from "./send-HzJbRmiM.js";
import { i as getTelegramSequentialKey, n as buildTelegramReplyFenceLaneKey, r as supersedeTelegramReplyFenceLane, t as createTelegramBot } from "./bot-D0mzNk0g.js";
import { Worker } from "node:worker_threads";
import { run } from "@grammyjs/runner";
//#region extensions/telegram/src/polling-liveness.ts
var TelegramPollingLivenessTracker = class {
	#lastGetUpdatesAt;
	#lastGetUpdatesActivityAt;
	#lastGetUpdatesStartedAt = null;
	#lastGetUpdatesFinishedAt = null;
	#lastGetUpdatesDurationMs = null;
	#lastGetUpdatesOutcome = "not-started";
	#lastGetUpdatesError = null;
	#lastGetUpdatesOffset = null;
	#inFlightGetUpdates = 0;
	#stallDiagLoggedAt = 0;
	constructor(options = {}) {
		this.options = options;
		this.#lastGetUpdatesAt = this.#now();
		this.#lastGetUpdatesActivityAt = this.#lastGetUpdatesAt;
	}
	get inFlightGetUpdates() {
		return this.#inFlightGetUpdates;
	}
	noteGetUpdatesStarted(payload, at = this.#now()) {
		this.#lastGetUpdatesAt = at;
		this.#lastGetUpdatesActivityAt = at;
		this.#lastGetUpdatesStartedAt = at;
		this.#lastGetUpdatesOffset = resolveGetUpdatesOffset(payload);
		this.#inFlightGetUpdates += 1;
		this.#lastGetUpdatesOutcome = "started";
		this.#lastGetUpdatesError = null;
	}
	noteGetUpdatesSuccess(result, at = this.#now()) {
		this.#lastGetUpdatesActivityAt = at;
		this.#lastGetUpdatesFinishedAt = at;
		this.#lastGetUpdatesDurationMs = this.#lastGetUpdatesStartedAt == null ? null : at - this.#lastGetUpdatesStartedAt;
		this.#lastGetUpdatesOutcome = Array.isArray(result) ? `ok:${result.length}` : "ok";
		this.options.onPollSuccess?.(at);
	}
	noteGetUpdatesSuccessCount(count, at = this.#now()) {
		this.#lastGetUpdatesActivityAt = at;
		this.#lastGetUpdatesFinishedAt = at;
		this.#lastGetUpdatesDurationMs = this.#lastGetUpdatesStartedAt == null ? null : at - this.#lastGetUpdatesStartedAt;
		const normalizedCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
		this.#lastGetUpdatesOutcome = `ok:${normalizedCount}`;
		this.options.onPollSuccess?.(at);
	}
	noteGetUpdatesError(err, at = this.#now()) {
		this.#lastGetUpdatesActivityAt = at;
		this.#lastGetUpdatesFinishedAt = at;
		this.#lastGetUpdatesDurationMs = this.#lastGetUpdatesStartedAt == null ? null : at - this.#lastGetUpdatesStartedAt;
		this.#lastGetUpdatesOutcome = "error";
		this.#lastGetUpdatesError = formatErrorMessage(err);
	}
	noteGetUpdatesFinished() {
		this.#inFlightGetUpdates = Math.max(0, this.#inFlightGetUpdates - 1);
	}
	noteGetUpdatesActivity(at = this.#now()) {
		this.#lastGetUpdatesActivityAt = at;
	}
	detectStall(params) {
		const now = params.now ?? this.#now();
		const activeElapsed = this.#inFlightGetUpdates > 0 && this.#lastGetUpdatesStartedAt != null ? now - this.#lastGetUpdatesActivityAt : 0;
		const idleElapsed = this.#inFlightGetUpdates > 0 ? 0 : now - (this.#lastGetUpdatesFinishedAt ?? this.#lastGetUpdatesAt);
		const elapsed = this.#inFlightGetUpdates > 0 ? activeElapsed : idleElapsed;
		if (elapsed <= params.thresholdMs) return null;
		if (this.#stallDiagLoggedAt && now - this.#stallDiagLoggedAt < params.thresholdMs / 2) return null;
		this.#stallDiagLoggedAt = now;
		return { message: `Polling stall detected (${this.#inFlightGetUpdates > 0 ? `active getUpdates stuck for ${formatDurationPrecise(elapsed)}` : `no completed getUpdates for ${formatDurationPrecise(elapsed)}`}); forcing restart. [diag ${this.formatDiagnosticFields("error")}]` };
	}
	formatDiagnosticFields(errorLabel) {
		const error = this.#lastGetUpdatesError && errorLabel ? ` ${errorLabel}=${this.#lastGetUpdatesError}` : "";
		return `inFlight=${this.#inFlightGetUpdates} outcome=${this.#lastGetUpdatesOutcome} startedAt=${this.#lastGetUpdatesStartedAt ?? "n/a"} finishedAt=${this.#lastGetUpdatesFinishedAt ?? "n/a"} durationMs=${this.#lastGetUpdatesDurationMs ?? "n/a"} offset=${this.#lastGetUpdatesOffset ?? "n/a"}${error}`;
	}
	#now() {
		return this.options.now?.() ?? Date.now();
	}
};
function resolveGetUpdatesOffset(payload) {
	if (!payload || typeof payload !== "object" || !("offset" in payload)) return null;
	const offset = payload.offset;
	return typeof offset === "number" ? offset : null;
}
//#endregion
//#region extensions/telegram/src/polling-status.ts
function createTelegramPollingStatusPublisher(setStatus) {
	return {
		notePollingStart() {
			setStatus?.({
				mode: "polling",
				connected: false,
				lastConnectedAt: null,
				lastEventAt: null,
				lastTransportActivityAt: null
			});
		},
		notePollSuccess(at = Date.now()) {
			setStatus?.({
				...createConnectedChannelStatusPatch(at),
				...createTransportActivityStatusPatch(at),
				mode: "polling",
				lastError: null
			});
		},
		notePollingError(error) {
			setStatus?.({
				mode: "polling",
				connected: false,
				lastError: error
			});
		},
		notePollingStop() {
			setStatus?.({
				mode: "polling",
				connected: false
			});
		}
	};
}
//#endregion
//#region extensions/telegram/src/polling-transport-state.ts
var TelegramPollingTransportState = class {
	#telegramTransport;
	#transportDirty = false;
	#disposed = false;
	constructor(opts) {
		this.opts = opts;
		this.#telegramTransport = opts.initialTransport;
	}
	markDirty() {
		this.#transportDirty = true;
	}
	acquireForNextCycle() {
		if (this.#disposed) return;
		const previous = this.#telegramTransport;
		const nextTransport = this.#transportDirty || !previous ? this.opts.createTelegramTransport?.() ?? previous : previous;
		if (this.#transportDirty && previous && nextTransport !== previous) {
			this.opts.log("[telegram][diag] closing stale transport before rebuild");
			this.#closeTransportAsync(previous, "stale-transport rebuild");
		}
		if (this.#transportDirty && nextTransport) this.opts.log("[telegram][diag] rebuilding transport for next polling cycle");
		this.#telegramTransport = nextTransport;
		this.#transportDirty = false;
		return nextTransport;
	}
	async dispose() {
		if (this.#disposed) return;
		this.#disposed = true;
		const transport = this.#telegramTransport;
		this.#telegramTransport = void 0;
		if (!transport) return;
		try {
			await transport.close();
		} catch (err) {
			this.opts.log(`[telegram][diag] failed to close transport during dispose: ${formatCloseError(err)}`);
		}
	}
	#closeTransportAsync(transport, context) {
		transport.close().catch((err) => {
			this.opts.log(`[telegram][diag] failed to close transport (${context}): ${formatCloseError(err)}`);
		});
	}
};
function formatCloseError(err) {
	if (err instanceof Error) return err.message;
	return String(err);
}
//#endregion
//#region extensions/telegram/src/telegram-ingress-worker.ts
const createTelegramIngressWorker = (options) => {
	const listeners = /* @__PURE__ */ new Set();
	const worker = new Worker(new URL("./telegram-ingress-worker.runtime.js", import.meta.url), { workerData: options });
	const taskPromise = new Promise((resolve, reject) => {
		worker.once("error", reject);
		worker.once("exit", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(/* @__PURE__ */ new Error(`Telegram ingress worker exited with code ${code}`));
		});
	});
	worker.on("message", (message) => {
		for (const listener of listeners) listener(message);
	});
	return {
		onMessage(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		async stop() {
			worker.postMessage({ type: "stop" });
			const timeout = setTimeout(() => {
				worker.terminate();
			}, 15e3);
			timeout.unref?.();
			try {
				await taskPromise.catch(() => void 0);
			} finally {
				clearTimeout(timeout);
			}
		},
		task() {
			return taskPromise;
		}
	};
};
//#endregion
//#region extensions/telegram/src/polling-session.ts
const TELEGRAM_POLL_RESTART_POLICY = {
	initialMs: 2e3,
	maxMs: 3e4,
	factor: 1.8,
	jitter: .25
};
const DEFAULT_POLL_STALL_THRESHOLD_MS = 12e4;
const MIN_POLL_STALL_THRESHOLD_MS = 3e4;
const MAX_POLL_STALL_THRESHOLD_MS = 6e5;
const POLL_WATCHDOG_INTERVAL_MS = 3e4;
const POLL_STOP_GRACE_MS = 15e3;
const ISOLATED_INGRESS_BACKLOG_STALL_MS = 25 * 6e4;
const TELEGRAM_SPOOLED_HANDLER_ABORT_GRACE_MS = 5e3;
const TELEGRAM_SPOOLED_HANDLER_TIMEOUT_ENV = "OPENCLAW_TELEGRAM_SPOOLED_HANDLER_TIMEOUT_MS";
const TELEGRAM_SPOOLED_DRAIN_START_LIMIT = 100;
const TELEGRAM_SPOOLED_DRAIN_SCAN_LIMIT = TELEGRAM_SPOOLED_DRAIN_START_LIMIT * 10;
const TELEGRAM_POLLING_CLIENT_TIMEOUT_FLOOR_SECONDS = Math.ceil(TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_MS / 1e3);
const MISSING_AGENT_HARNESS_ERROR_NAME = "MissingAgentHarnessError";
const MISSING_AGENT_HARNESS_MESSAGE_RE = /Requested agent harness "[^"]+" is not registered\./u;
function normalizeTelegramAccountId(accountId) {
	return accountId?.trim() || "default";
}
function resolveNonRetryableSpooledUpdateFailure(err) {
	for (const candidate of collectErrorGraphCandidates(err, (current) => [current.cause, current.error])) {
		const message = formatErrorMessage(candidate);
		if (readErrorName(candidate) === MISSING_AGENT_HARNESS_ERROR_NAME || MISSING_AGENT_HARNESS_MESSAGE_RE.test(message)) return {
			reason: "missing-agent-harness",
			message
		};
	}
	return null;
}
const waitForGracefulStop = async (stop) => {
	let timer;
	try {
		await Promise.race([stop(), new Promise((resolve) => {
			timer = setTimeout(resolve, POLL_STOP_GRACE_MS);
			timer.unref?.();
		})]);
	} finally {
		if (timer) clearTimeout(timer);
	}
};
const waitForSpooledHandlerTaskSettlement = async (params) => {
	if (params.abortSignal?.aborted) return false;
	let timer;
	let removeAbortListener;
	try {
		return await Promise.race([params.task.then(() => true, () => true), new Promise((resolve) => {
			timer = setTimeout(() => resolve(false), params.timeoutMs);
			timer.unref?.();
			const abort = () => resolve(false);
			params.abortSignal?.addEventListener("abort", abort, { once: true });
			removeAbortListener = () => params.abortSignal?.removeEventListener("abort", abort);
		})]);
	} finally {
		if (timer) clearTimeout(timer);
		removeAbortListener?.();
	}
};
const resolvePollingStallThresholdMs = (value) => {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_POLL_STALL_THRESHOLD_MS;
	return Math.min(MAX_POLL_STALL_THRESHOLD_MS, Math.max(MIN_POLL_STALL_THRESHOLD_MS, Math.floor(value)));
};
const activeSpooledUpdateHandlersByLane = /* @__PURE__ */ new Map();
function resolveSpooledUpdateHandlerTimeoutMs(params) {
	const candidates = [params.configured, Number(params.env?.[TELEGRAM_SPOOLED_HANDLER_TIMEOUT_ENV])];
	for (const candidate of candidates) if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) return Math.floor(candidate);
	return ISOLATED_INGRESS_BACKLOG_STALL_MS;
}
function resolvePositiveFiniteMs(value, fallback) {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
	return fallback;
}
function buildSpooledUpdateHandlerKey(params) {
	return `${params.spoolDir}\0${params.laneKey}`;
}
function isSpooledUpdateHandlerKeyForSpool(handlerKey, spoolDir) {
	return handlerKey.startsWith(`${spoolDir}\0`);
}
var TelegramPollingSession = class {
	#restartAttempts = 0;
	#webhookCleared = false;
	#forceRestarted = false;
	#activeRunner;
	#activeFetchAbort;
	#spooledUpdateHandlerKeys = /* @__PURE__ */ new Set();
	#transportState;
	#status;
	#stallThresholdMs;
	#spooledUpdateHandlerTimeoutMs;
	#spooledUpdateHandlerAbortGraceMs;
	#deliveryDrainInFlight = false;
	constructor(opts) {
		this.opts = opts;
		this.#transportState = new TelegramPollingTransportState({
			log: opts.log,
			initialTransport: opts.telegramTransport,
			createTelegramTransport: opts.createTelegramTransport
		});
		this.#status = createTelegramPollingStatusPublisher(opts.setStatus);
		this.#stallThresholdMs = resolvePollingStallThresholdMs(opts.stallThresholdMs);
		this.#spooledUpdateHandlerTimeoutMs = resolveSpooledUpdateHandlerTimeoutMs({
			...opts.isolatedIngress?.spooledUpdateHandlerTimeoutMs !== void 0 ? { configured: opts.isolatedIngress.spooledUpdateHandlerTimeoutMs } : {},
			env: process.env
		});
		this.#spooledUpdateHandlerAbortGraceMs = resolvePositiveFiniteMs(opts.isolatedIngress?.spooledUpdateHandlerAbortGraceMs, TELEGRAM_SPOOLED_HANDLER_ABORT_GRACE_MS);
	}
	get activeRunner() {
		return this.#activeRunner;
	}
	markForceRestarted() {
		this.#forceRestarted = true;
	}
	markTransportDirty() {
		this.#transportState.markDirty();
	}
	abortActiveFetch() {
		this.#activeFetchAbort?.abort();
	}
	async runUntilAbort() {
		this.#status.notePollingStart();
		try {
			while (!this.opts.abortSignal?.aborted) {
				const bot = await this.#createPollingBot();
				if (!bot) continue;
				const cleanupState = await this.#ensureWebhookCleanup(bot);
				if (cleanupState === "retry") continue;
				if (cleanupState === "exit") return;
				if ((this.opts.isolatedIngress?.enabled ? await this.#runIsolatedIngressCycle(bot) : await this.#runPollingCycle(bot)) === "exit") return;
			}
		} finally {
			await this.#transportState.dispose();
			this.#status.notePollingStop();
		}
	}
	async #waitBeforeRestart(buildLine) {
		this.#restartAttempts += 1;
		const delayMs = computeBackoff(TELEGRAM_POLL_RESTART_POLICY, this.#restartAttempts);
		const delay = formatDurationPrecise(delayMs);
		this.opts.log(buildLine(delay));
		try {
			await sleepWithAbort(delayMs, this.opts.abortSignal);
		} catch (sleepErr) {
			if (this.opts.abortSignal?.aborted) return false;
			throw sleepErr;
		}
		return true;
	}
	async #waitBeforeRetryOnRecoverableSetupError(err, logPrefix) {
		if (this.opts.abortSignal?.aborted) return false;
		if (!isRecoverableTelegramNetworkError(err, { context: "unknown" })) throw err;
		return this.#waitBeforeRestart((delay) => `${logPrefix}: ${formatErrorMessage(err)}; retrying in ${delay}.`);
	}
	#drainPendingDeliveriesAfterReconnect() {
		if (this.#deliveryDrainInFlight) return;
		if (!this.opts.config) return;
		this.#deliveryDrainInFlight = true;
		const accountId = normalizeTelegramAccountId(this.opts.accountId);
		const cfg = this.opts.config;
		drainPendingDeliveries({
			drainKey: `telegram:${accountId}`,
			logLabel: "Telegram reconnect drain",
			cfg,
			log: {
				info: (message) => this.opts.log(`[telegram][diag] ${message}`),
				warn: (message) => this.opts.log(`[telegram] ${message}`),
				error: (message) => this.opts.log(`[telegram] ${message}`)
			},
			selectEntry: (entry) => ({
				match: entry.channel === "telegram" && normalizeTelegramAccountId(entry.accountId) === accountId,
				bypassBackoff: false
			})
		}).catch((err) => {
			this.opts.log(`[telegram] reconnect delivery drain failed: ${formatErrorMessage(err)}`);
		}).finally(() => {
			this.#deliveryDrainInFlight = false;
		});
	}
	async #createPollingBot() {
		const fetchAbortController = new AbortController();
		this.#activeFetchAbort = fetchAbortController;
		const telegramTransport = this.#transportState.acquireForNextCycle();
		const persistedLastUpdateId = this.opts.getLastUpdateId();
		const updateOffset = {
			lastUpdateId: this.opts.isolatedIngress?.enabled ? null : persistedLastUpdateId,
			persistenceFloorUpdateId: persistedLastUpdateId,
			onUpdateId: this.opts.persistUpdateId
		};
		try {
			return createTelegramBot({
				token: this.opts.token,
				runtime: this.opts.runtime,
				proxyFetch: this.opts.proxyFetch,
				config: this.opts.config,
				accountId: this.opts.accountId,
				botInfo: this.opts.botInfo,
				fetchAbortSignal: fetchAbortController.signal,
				minimumClientTimeoutSeconds: TELEGRAM_POLLING_CLIENT_TIMEOUT_FLOOR_SECONDS,
				...updateOffset ? { updateOffset } : {},
				telegramTransport
			});
		} catch (err) {
			await this.#waitBeforeRetryOnRecoverableSetupError(err, "Telegram setup network error");
			if (this.#activeFetchAbort === fetchAbortController) this.#activeFetchAbort = void 0;
			return;
		}
	}
	async #ensureWebhookCleanup(bot) {
		if (this.#webhookCleared) return "ready";
		try {
			await withTelegramApiErrorLogging({
				operation: "deleteWebhook",
				runtime: this.opts.runtime,
				fn: () => bot.api.deleteWebhook({ drop_pending_updates: false })
			});
			this.#webhookCleared = true;
			return "ready";
		} catch (err) {
			if (isRecoverableTelegramNetworkError(err, { context: "unknown" })) {
				this.opts.log(`[telegram] deleteWebhook failed with a recoverable network error; continuing to polling so getUpdates can confirm webhook state: ${formatErrorMessage(err)}`);
				return "ready";
			}
			return await this.#waitBeforeRetryOnRecoverableSetupError(err, "Telegram webhook cleanup failed") ? "retry" : "exit";
		}
	}
	async #claimSpooledUpdate(update) {
		try {
			return await claimTelegramSpooledUpdate(update);
		} catch (err) {
			this.opts.log(`[telegram][diag] spooled update ${update.updateId} claim failed; keeping for retry: ${formatErrorMessage(err)}`);
			return null;
		}
	}
	async #handleClaimedSpooledUpdate(params) {
		try {
			await params.bot.handleUpdate(params.update.update);
		} catch (err) {
			await this.#releaseFailedSpooledUpdate({
				err,
				update: params.update
			});
			return false;
		}
		try {
			await deleteTelegramSpooledUpdate(params.update);
			return true;
		} catch (err) {
			this.opts.log(`[telegram][diag] spooled update ${params.update.updateId} completed but processing marker cleanup failed: ${formatErrorMessage(err)}`);
			return false;
		}
	}
	async #releaseFailedSpooledUpdate(params) {
		const nonRetryable = resolveNonRetryableSpooledUpdateFailure(params.err);
		if (nonRetryable) try {
			if (!await failTelegramSpooledUpdateClaim({
				update: params.update,
				reason: nonRetryable.reason,
				message: nonRetryable.message
			})) {
				this.opts.log(`[telegram][diag] spooled update ${params.update.updateId} failed with non-retryable ${nonRetryable.reason}, but no processing marker remained to dead-letter.`);
				return;
			}
			this.opts.log(`[telegram][diag] spooled update ${params.update.updateId} failed with non-retryable ${nonRetryable.reason}; dead-lettered: ${nonRetryable.message}`);
			return;
		} catch (failErr) {
			this.opts.log(`[telegram][diag] spooled update ${params.update.updateId} failed with non-retryable ${nonRetryable.reason}, but could not be dead-lettered: ${formatErrorMessage(failErr)}`);
		}
		try {
			await releaseTelegramSpooledUpdateClaim(params.update);
		} catch (releaseErr) {
			this.opts.log(`[telegram][diag] spooled update ${params.update.updateId} failed and could not be requeued: ${formatErrorMessage(releaseErr)}`);
			return;
		}
		this.opts.log(`[telegram][diag] spooled update ${params.update.updateId} failed; keeping for retry: ${formatErrorMessage(params.err)}`);
	}
	async #waitForSpooledUpdateHandlers() {
		await Promise.allSettled([...this.#spooledUpdateHandlerKeys].map((handlerKey) => activeSpooledUpdateHandlersByLane.get(handlerKey)?.task).filter((task) => Boolean(task)));
	}
	#spooledUpdateLaneKey(update) {
		return getTelegramSequentialKey({
			update: update.update,
			...this.opts.botInfo ? { me: this.opts.botInfo } : {}
		});
	}
	#activeSpooledUpdateLaneKeysForSpool(spoolDir) {
		const laneKeys = /* @__PURE__ */ new Set();
		for (const [handlerKey, handler] of activeSpooledUpdateHandlersByLane) if (isSpooledUpdateHandlerKeyForSpool(handlerKey, spoolDir)) laneKeys.add(handler.laneKey);
		return laneKeys;
	}
	async #drainSpooledUpdates(params) {
		const activeLaneKeys = this.#activeSpooledUpdateLaneKeysForSpool(params.spoolDir);
		await recoverStaleTelegramSpooledUpdateClaims({
			spoolDir: params.spoolDir,
			staleMs: 0,
			shouldRecover: (claim) => !activeLaneKeys.has(this.#spooledUpdateLaneKey(claim)) && !isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess(claim)
		});
		const claimedLaneKeys = new Set((await listTelegramSpooledUpdateClaims({ spoolDir: params.spoolDir })).map((claim) => this.#spooledUpdateLaneKey(claim)));
		const updates = await listTelegramSpooledUpdates({
			spoolDir: params.spoolDir,
			limit: TELEGRAM_SPOOLED_DRAIN_SCAN_LIMIT
		});
		const blockedByLane = /* @__PURE__ */ new Set();
		let started = 0;
		for (const update of updates) {
			const laneKey = this.#spooledUpdateLaneKey(update);
			if (this.opts.abortSignal?.aborted) break;
			const handlerKey = buildSpooledUpdateHandlerKey({
				spoolDir: params.spoolDir,
				laneKey
			});
			if (activeSpooledUpdateHandlersByLane.has(handlerKey)) {
				blockedByLane.add(handlerKey);
				continue;
			}
			if (claimedLaneKeys.has(laneKey)) continue;
			const claimedUpdate = await this.#claimSpooledUpdate(update);
			if (!claimedUpdate) {
				claimedLaneKeys.add(laneKey);
				continue;
			}
			const handler = this.#handleClaimedSpooledUpdate({
				bot: params.bot,
				update: claimedUpdate
			});
			const state = {
				handlerKey,
				laneKey,
				task: handler,
				update: claimedUpdate,
				updateId: update.updateId,
				startedAt: Date.now()
			};
			activeSpooledUpdateHandlersByLane.set(handlerKey, state);
			this.#spooledUpdateHandlerKeys.add(handlerKey);
			claimedLaneKeys.add(laneKey);
			handler.finally(() => {
				if (activeSpooledUpdateHandlersByLane.get(handlerKey) === state) activeSpooledUpdateHandlersByLane.delete(handlerKey);
				this.#spooledUpdateHandlerKeys.delete(handlerKey);
			});
			started += 1;
			if (started >= TELEGRAM_SPOOLED_DRAIN_START_LIMIT) break;
		}
		return {
			blockedByLane,
			started
		};
	}
	#detectTimedOutSpooledHandler(blockedHandlerKeys) {
		const now = Date.now();
		let timedOut = null;
		for (const handlerKey of blockedHandlerKeys) {
			const handler = activeSpooledUpdateHandlersByLane.get(handlerKey);
			if (!handler || handler.timedOutAt !== void 0) continue;
			const ageMs = now - handler.startedAt;
			if (ageMs <= this.#spooledUpdateHandlerTimeoutMs) continue;
			if (!timedOut || ageMs > timedOut.ageMs) timedOut = {
				handler,
				ageMs
			};
		}
		return timedOut;
	}
	async #recoverTimedOutSpooledHandler(blockedHandlerKeys) {
		const timedOutHandler = this.#detectTimedOutSpooledHandler(blockedHandlerKeys);
		if (!timedOutHandler) return null;
		const handler = timedOutHandler.handler;
		const activeHandler = activeSpooledUpdateHandlersByLane.get(handler.handlerKey);
		if (!activeHandler || activeHandler !== handler) return null;
		const age = formatDurationPrecise(timedOutHandler.ageMs);
		activeHandler.timedOutAt = Date.now();
		const message = `Telegram isolated polling spool handler timed out behind update ${handler.updateId} on lane ${handler.laneKey} after ${age}; marking the update failed, aborting active reply work, and restarting isolated ingress so later updates can drain.`;
		activeHandler.timeoutMessage = message;
		try {
			if (!await failTelegramSpooledUpdateClaim({
				update: handler.update,
				reason: "handler-timeout",
				message
			})) {
				this.opts.log(`[telegram][diag] timed out spooled update ${handler.updateId} no longer had a processing marker to fail.`);
				this.#status.notePollingError(message);
				return {
					handlerKey: handler.handlerKey,
					restart: false
				};
			}
		} catch (err) {
			this.opts.log(`[telegram][diag] timed out spooled update ${handler.updateId} could not be marked failed: ${formatErrorMessage(err)}`);
			this.#status.notePollingError(message);
			return {
				handlerKey: handler.handlerKey,
				restart: false
			};
		}
		if (!supersedeTelegramReplyFenceLane(buildTelegramReplyFenceLaneKey({
			accountId: this.opts.accountId,
			sequentialKey: handler.laneKey
		}))) this.opts.log(`[telegram][diag] timed out spooled update ${handler.updateId} had no active reply fence on lane ${handler.laneKey}; keeping the lane guarded until the handler stops.`);
		if (!await waitForSpooledHandlerTaskSettlement({
			task: handler.task,
			timeoutMs: this.#spooledUpdateHandlerAbortGraceMs,
			abortSignal: this.opts.abortSignal
		}) && activeSpooledUpdateHandlersByLane.get(handler.handlerKey) === activeHandler) {
			this.opts.log(`[telegram][diag] timed out spooled update ${handler.updateId} did not stop within ${formatDurationPrecise(this.#spooledUpdateHandlerAbortGraceMs)} after reply abort; keeping lane ${handler.laneKey} guarded.`);
			this.#status.notePollingError(message);
			return {
				handlerKey: handler.handlerKey,
				restart: false
			};
		}
		if (activeSpooledUpdateHandlersByLane.get(handler.handlerKey) === activeHandler) activeSpooledUpdateHandlersByLane.delete(handler.handlerKey);
		this.#spooledUpdateHandlerKeys.delete(handler.handlerKey);
		this.opts.log(`[telegram] ${message}`);
		this.#status.notePollingError(message);
		return {
			handlerKey: handler.handlerKey,
			restart: true
		};
	}
	async #runIsolatedIngressCycle(bot) {
		const ingress = this.opts.isolatedIngress;
		if (!ingress?.enabled) return this.#runPollingCycle(bot);
		try {
			await bot.init();
		} catch (err) {
			return await this.#waitBeforeRetryOnRecoverableSetupError(err, "Telegram bot init failed") ? "continue" : "exit";
		}
		const spoolDir = ingress.spoolDir ?? resolveTelegramIngressSpoolDir({ accountId: this.opts.accountId });
		const worker = (ingress.createWorker ?? createTelegramIngressWorker)({
			token: this.opts.token,
			accountId: this.opts.accountId,
			initialUpdateId: this.opts.getLastUpdateId(),
			spoolDir,
			apiRoot: ingress.apiRoot,
			timeoutSeconds: ingress.timeoutSeconds,
			network: ingress.network,
			proxy: ingress.proxy
		});
		let stopWorkerPromise;
		const stopWorker = () => {
			stopWorkerPromise ??= Promise.resolve(worker.stop()).then(() => void 0).catch(() => {});
			return stopWorkerPromise;
		};
		this.opts.log(`[telegram][diag] isolated polling ingress started spool=${spoolDir}`);
		const pollState = {
			startedAt: null,
			offset: null,
			outcome: "not-started"
		};
		const liveness = new TelegramPollingLivenessTracker();
		let consecutiveDrainFailures = 0;
		let restartRequested = false;
		let stalledRestart = false;
		let forceCycleTimer;
		let forceCycleResolve;
		const forceCyclePromise = new Promise((resolve) => {
			forceCycleResolve = resolve;
		});
		const stalledBacklogKeys = /* @__PURE__ */ new Set();
		const unsubscribe = worker.onMessage((message) => {
			if (message.type === "poll-start") {
				liveness.noteGetUpdatesStarted({ offset: message.offset }, message.startedAt);
				pollState.startedAt = message.startedAt;
				pollState.offset = message.offset;
				pollState.outcome = "started";
				delete pollState.error;
				return;
			}
			if (message.type === "poll-success") {
				liveness.noteGetUpdatesSuccessCount(message.count, message.finishedAt);
				liveness.noteGetUpdatesFinished();
				if (!restartRequested && stalledBacklogKeys.size === 0) this.#status.notePollSuccess(message.finishedAt);
				this.#drainPendingDeliveriesAfterReconnect();
				pollState.outcome = `ok:${message.count}`;
				return;
			}
			if (message.type === "poll-error") {
				liveness.noteGetUpdatesError(new Error(message.message), message.finishedAt);
				liveness.noteGetUpdatesFinished();
				pollState.outcome = "error";
				pollState.error = message.message;
				return;
			}
			if (message.type === "spooled") liveness.noteGetUpdatesActivity();
		});
		const stopOnAbort = () => {
			stopWorker();
		};
		this.opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
		const drainIntervalMs = Math.max(100, Math.floor(ingress.drainIntervalMs ?? 500));
		let drainActive = false;
		const stopBot = () => {
			return Promise.resolve(bot.stop()).then(() => void 0).catch(() => {});
		};
		const drainOnce = async () => {
			if (restartRequested || drainActive || this.opts.abortSignal?.aborted) return;
			drainActive = true;
			try {
				const drain = await this.#drainSpooledUpdates({
					bot,
					spoolDir
				});
				consecutiveDrainFailures = 0;
				for (const handlerKey of stalledBacklogKeys) if (!activeSpooledUpdateHandlersByLane.has(handlerKey) || !drain.blockedByLane.has(handlerKey)) stalledBacklogKeys.delete(handlerKey);
				for (const handlerKey of drain.blockedByLane) {
					const handler = activeSpooledUpdateHandlersByLane.get(handlerKey);
					if (handler?.timedOutAt === void 0) continue;
					stalledBacklogKeys.add(handlerKey);
					if (handler.timeoutMessage) this.#status.notePollingError(handler.timeoutMessage);
				}
				const timedOutRecovery = await this.#recoverTimedOutSpooledHandler(drain.blockedByLane);
				if (timedOutRecovery?.restart) {
					restartRequested = true;
					stopWorker();
				} else if (timedOutRecovery) stalledBacklogKeys.add(timedOutRecovery.handlerKey);
			} catch (err) {
				consecutiveDrainFailures += 1;
				this.opts.log(`[telegram][diag] isolated polling spool drain failed (${consecutiveDrainFailures}): ${formatErrorMessage(err)}`);
			} finally {
				drainActive = false;
			}
		};
		await drainOnce();
		const drainTimer = setInterval(() => {
			drainOnce();
		}, drainIntervalMs);
		drainTimer.unref?.();
		const watchdog = setInterval(() => {
			if (this.opts.abortSignal?.aborted || restartRequested) return;
			const stall = liveness.detectStall({ thresholdMs: this.#stallThresholdMs });
			if (!stall) return;
			this.#transportState.markDirty();
			stalledRestart = true;
			restartRequested = true;
			this.opts.log(`[telegram] ${stall.message}`);
			this.#status.notePollingError(stall.message);
			stopWorker();
			if (!forceCycleTimer) forceCycleTimer = setTimeout(() => {
				if (this.opts.abortSignal?.aborted) return;
				this.opts.log(`[telegram] Isolated polling ingress stop timed out after ${formatDurationPrecise(POLL_STOP_GRACE_MS)}; forcing restart cycle.`);
				forceCycleResolve?.();
			}, POLL_STOP_GRACE_MS);
		}, POLL_WATCHDOG_INTERVAL_MS);
		watchdog.unref?.();
		try {
			try {
				await Promise.race([worker.task(), forceCyclePromise]);
			} catch (err) {
				if (this.opts.abortSignal?.aborted) return "exit";
				if (pollState.error && !isRecoverableTelegramNetworkError(new Error(pollState.error), { context: "polling" })) {
					this.#status.notePollingError(pollState.error);
					throw new Error(pollState.error, { cause: err });
				}
				const message = formatErrorMessage(err);
				this.opts.log(`[telegram][diag] isolated polling ingress failed: ${message}`);
				this.#status.notePollingError(message);
				return await this.#waitBeforeRestart((delay) => `Telegram isolated polling ingress failed; restarting in ${delay}.`) ? "continue" : "exit";
			}
			if (this.opts.abortSignal?.aborted) return "exit";
			if (restartRequested) {
				if (stalledRestart) this.opts.log(`[telegram][diag] isolated polling ingress finished reason=polling stall detected ${liveness.formatDiagnosticFields("error")}`);
				return "continue";
			}
			const errorText = pollState.error ? ` error=${pollState.error}` : "";
			this.opts.log(`[telegram][diag] isolated polling ingress stopped outcome=${pollState.outcome} startedAt=${pollState.startedAt ?? "n/a"} offset=${pollState.offset ?? "n/a"}${errorText}`);
			return await this.#waitBeforeRestart((delay) => `Telegram isolated polling ingress stopped; restarting in ${delay}.`) ? "continue" : "exit";
		} finally {
			clearInterval(watchdog);
			clearInterval(drainTimer);
			if (forceCycleTimer) clearTimeout(forceCycleTimer);
			unsubscribe();
			this.opts.abortSignal?.removeEventListener("abort", stopOnAbort);
			await stopWorker();
			if (!restartRequested) {
				await drainOnce();
				await waitForGracefulStop(() => this.#waitForSpooledUpdateHandlers());
			}
			await waitForGracefulStop(stopBot);
		}
	}
	async #runPollingCycle(bot) {
		const liveness = new TelegramPollingLivenessTracker({ onPollSuccess: (finishedAt) => {
			this.#status.notePollSuccess(finishedAt);
			this.#drainPendingDeliveriesAfterReconnect();
		} });
		bot.api.config.use(async (prev, method, payload, signal) => {
			if (method !== "getUpdates") return await prev(method, payload, signal);
			liveness.noteGetUpdatesStarted(payload);
			try {
				const result = await prev(method, payload, signal);
				liveness.noteGetUpdatesSuccess(result);
				return result;
			} catch (err) {
				liveness.noteGetUpdatesError(err);
				throw err;
			} finally {
				liveness.noteGetUpdatesFinished();
			}
		});
		const runner = run(bot, this.opts.runnerOptions);
		this.opts.log(`[telegram][diag] polling cycle started ${liveness.formatDiagnosticFields()}`);
		this.#activeRunner = runner;
		const fetchAbortController = this.#activeFetchAbort;
		const abortFetch = () => {
			fetchAbortController?.abort();
		};
		if (this.opts.abortSignal && fetchAbortController) this.opts.abortSignal.addEventListener("abort", abortFetch, { once: true });
		let stopPromise;
		let stalledRestart = false;
		let forceCycleTimer;
		let forceCycleResolve;
		const forceCyclePromise = new Promise((resolve) => {
			forceCycleResolve = resolve;
		});
		const stopRunner = () => {
			fetchAbortController?.abort();
			stopPromise ??= Promise.resolve(runner.stop()).then(() => void 0).catch(() => {});
			return stopPromise;
		};
		const stopBot = () => {
			return Promise.resolve(bot.stop()).then(() => void 0).catch(() => {});
		};
		const stopOnAbort = () => {
			if (this.opts.abortSignal?.aborted) stopRunner();
		};
		const watchdog = setInterval(() => {
			if (this.opts.abortSignal?.aborted) return;
			const stall = liveness.detectStall({ thresholdMs: this.#stallThresholdMs });
			if (stall) {
				this.#transportState.markDirty();
				stalledRestart = true;
				this.opts.log(`[telegram] ${stall.message}`);
				stopRunner();
				stopBot();
				if (!forceCycleTimer) forceCycleTimer = setTimeout(() => {
					if (this.opts.abortSignal?.aborted) return;
					this.opts.log(`[telegram] Polling runner stop timed out after ${formatDurationPrecise(POLL_STOP_GRACE_MS)}; forcing restart cycle.`);
					forceCycleResolve?.();
				}, POLL_STOP_GRACE_MS);
			}
		}, POLL_WATCHDOG_INTERVAL_MS);
		this.opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
		try {
			await Promise.race([runner.task(), forceCyclePromise]);
			if (this.opts.abortSignal?.aborted) return "exit";
			const reason = stalledRestart ? "polling stall detected" : this.#forceRestarted ? "unhandled network error" : "runner stopped (maxRetryTime exceeded or graceful stop)";
			this.#forceRestarted = false;
			this.opts.log(`[telegram][diag] polling cycle finished reason=${reason} ${liveness.formatDiagnosticFields("error")}`);
			return await this.#waitBeforeRestart((delay) => `Telegram polling runner stopped (${reason}); restarting in ${delay}.`) ? "continue" : "exit";
		} catch (err) {
			this.#forceRestarted = false;
			if (this.opts.abortSignal?.aborted) throw err;
			const isConflict = isGetUpdatesConflict(err);
			if (isConflict) this.#webhookCleared = false;
			const isRecoverable = isRecoverableTelegramNetworkError(err, { context: "polling" });
			if (isRecoverable || isConflict) this.#transportState.markDirty();
			if (!isConflict && !isRecoverable) throw err;
			const reason = isConflict ? "getUpdates conflict" : "network error";
			const errMsg = formatErrorMessage(err);
			const conflictHint = isConflict ? " Another OpenClaw gateway, script, or Telegram poller may be using this bot token; stop the duplicate poller or switch this account to webhook mode." : "";
			this.opts.log(`[telegram][diag] polling cycle error reason=${reason} ${liveness.formatDiagnosticFields("lastGetUpdatesError")} err=${errMsg}${conflictHint}`);
			return await this.#waitBeforeRestart((delay) => `Telegram ${reason}: ${errMsg};${conflictHint} retrying in ${delay}.`) ? "continue" : "exit";
		} finally {
			clearInterval(watchdog);
			if (forceCycleTimer) clearTimeout(forceCycleTimer);
			this.opts.abortSignal?.removeEventListener("abort", abortFetch);
			this.opts.abortSignal?.removeEventListener("abort", stopOnAbort);
			await waitForGracefulStop(stopRunner);
			await waitForGracefulStop(stopBot);
			this.#activeRunner = void 0;
			if (this.#activeFetchAbort === fetchAbortController) this.#activeFetchAbort = void 0;
		}
	}
};
const isGetUpdatesConflict = (err) => {
	if (!err || typeof err !== "object") return false;
	const typed = err;
	if ((typed.error_code ?? typed.errorCode) !== 409) return false;
	return normalizeLowercaseStringOrEmpty([
		typed.method,
		typed.description,
		typed.message
	].filter((value) => typeof value === "string").join(" ")).includes("getupdates");
};
//#endregion
export { TelegramPollingSession, deleteTelegramUpdateOffset, readTelegramUpdateOffset, writeTelegramUpdateOffset };
