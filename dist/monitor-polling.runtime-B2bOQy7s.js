import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { r as formatDurationPrecise } from "./format-duration-q-bulWEj.js";
import { n as sleepWithAbort, t as computeBackoff } from "./backoff-CW9s2Y7t.js";
import "./runtime-env-AKjXcC53.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import { t as isRecoverableTelegramNetworkError } from "./network-errors-eWehYGa6.js";
import { t as TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_MS } from "./request-timeouts-BU8iWn9a.js";
import { n as listTelegramSpooledUpdates, r as resolveTelegramIngressSpoolDir, t as deleteTelegramSpooledUpdate } from "./telegram-ingress-spool-Cbo6obJB.js";
import { n as readTelegramUpdateOffset, r as writeTelegramUpdateOffset } from "./update-offset-store-DDo2NizR.js";
import "./ssrf-runtime-B7YsbRmp.js";
import { n as createTransportActivityStatusPatch, t as createConnectedChannelStatusPatch } from "./gateway-runtime-6bU-ohwh.js";
import { C as withTelegramApiErrorLogging } from "./send-CHZ5FlJJ.js";
import { t as createTelegramBot } from "./bot-DVHbpZjZ.js";
import { Worker } from "node:worker_threads";
import { run } from "@grammyjs/runner";
//#region extensions/telegram/src/polling-liveness.ts
var TelegramPollingLivenessTracker = class {
	#lastGetUpdatesAt;
	#lastApiActivityAt;
	#nextInFlightApiCallId = 0;
	#latestInFlightApiStartedAt = null;
	#inFlightApiStartedAt = /* @__PURE__ */ new Map();
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
		this.#lastApiActivityAt = this.#now();
	}
	get inFlightGetUpdates() {
		return this.#inFlightGetUpdates;
	}
	noteApiCallStarted() {
		const startedAt = this.#now();
		const callId = this.#nextInFlightApiCallId;
		this.#nextInFlightApiCallId += 1;
		this.#inFlightApiStartedAt.set(callId, startedAt);
		this.#latestInFlightApiStartedAt = this.#latestInFlightApiStartedAt == null ? startedAt : Math.max(this.#latestInFlightApiStartedAt, startedAt);
		return callId;
	}
	noteApiCallSuccess(at = this.#now()) {
		this.#lastApiActivityAt = at;
	}
	noteApiCallFinished(callId) {
		const startedAt = this.#inFlightApiStartedAt.get(callId);
		this.#inFlightApiStartedAt.delete(callId);
		if (startedAt != null && this.#latestInFlightApiStartedAt === startedAt) this.#latestInFlightApiStartedAt = this.#resolveLatestInFlightApiStartedAt();
	}
	noteGetUpdatesStarted(payload, at = this.#now()) {
		this.#lastGetUpdatesAt = at;
		this.#lastGetUpdatesStartedAt = at;
		this.#lastGetUpdatesOffset = resolveGetUpdatesOffset(payload);
		this.#inFlightGetUpdates += 1;
		this.#lastGetUpdatesOutcome = "started";
		this.#lastGetUpdatesError = null;
	}
	noteGetUpdatesSuccess(result, at = this.#now()) {
		this.#lastGetUpdatesFinishedAt = at;
		this.#lastGetUpdatesDurationMs = this.#lastGetUpdatesStartedAt == null ? null : at - this.#lastGetUpdatesStartedAt;
		this.#lastGetUpdatesOutcome = Array.isArray(result) ? `ok:${result.length}` : "ok";
		this.#lastApiActivityAt = at;
		this.options.onPollSuccess?.(at);
	}
	noteGetUpdatesError(err, at = this.#now()) {
		this.#lastGetUpdatesFinishedAt = at;
		this.#lastGetUpdatesDurationMs = this.#lastGetUpdatesStartedAt == null ? null : at - this.#lastGetUpdatesStartedAt;
		this.#lastGetUpdatesOutcome = "error";
		this.#lastGetUpdatesError = formatErrorMessage(err);
		this.#lastApiActivityAt = at;
	}
	noteGetUpdatesFinished() {
		this.#inFlightGetUpdates = Math.max(0, this.#inFlightGetUpdates - 1);
	}
	detectStall(params) {
		const now = params.now ?? this.#now();
		const activeElapsed = this.#inFlightGetUpdates > 0 && this.#lastGetUpdatesStartedAt != null ? now - this.#lastGetUpdatesStartedAt : 0;
		const idleElapsed = this.#inFlightGetUpdates > 0 ? 0 : now - (this.#lastGetUpdatesFinishedAt ?? this.#lastGetUpdatesAt);
		const elapsed = this.#inFlightGetUpdates > 0 ? activeElapsed : idleElapsed;
		const apiElapsed = now - (this.#latestInFlightApiStartedAt == null ? this.#lastApiActivityAt : Math.max(this.#lastApiActivityAt, this.#latestInFlightApiStartedAt));
		if (elapsed <= params.thresholdMs || apiElapsed <= params.thresholdMs) return null;
		if (this.#stallDiagLoggedAt && now - this.#stallDiagLoggedAt < params.thresholdMs / 2) return null;
		this.#stallDiagLoggedAt = now;
		return { message: `Polling stall detected (${this.#inFlightGetUpdates > 0 ? `active getUpdates stuck for ${formatDurationPrecise(elapsed)}` : `no completed getUpdates for ${formatDurationPrecise(elapsed)}`}); forcing restart. [diag ${this.formatDiagnosticFields("error")}]` };
	}
	formatDiagnosticFields(errorLabel) {
		const error = this.#lastGetUpdatesError && errorLabel ? ` ${errorLabel}=${this.#lastGetUpdatesError}` : "";
		return `inFlight=${this.#inFlightGetUpdates} outcome=${this.#lastGetUpdatesOutcome} startedAt=${this.#lastGetUpdatesStartedAt ?? "n/a"} finishedAt=${this.#lastGetUpdatesFinishedAt ?? "n/a"} durationMs=${this.#lastGetUpdatesDurationMs ?? "n/a"} offset=${this.#lastGetUpdatesOffset ?? "n/a"}${error}`;
	}
	#resolveLatestInFlightApiStartedAt() {
		let newestStartedAt = null;
		for (const activeStartedAt of this.#inFlightApiStartedAt.values()) newestStartedAt = newestStartedAt == null ? activeStartedAt : Math.max(newestStartedAt, activeStartedAt);
		return newestStartedAt;
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
			worker["postMessage"]({ type: "stop" });
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
const TELEGRAM_POLLING_CLIENT_TIMEOUT_FLOOR_SECONDS = Math.ceil(TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_MS / 1e3);
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
const resolvePollingStallThresholdMs = (value) => {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_POLL_STALL_THRESHOLD_MS;
	return Math.min(MAX_POLL_STALL_THRESHOLD_MS, Math.max(MIN_POLL_STALL_THRESHOLD_MS, Math.floor(value)));
};
var TelegramPollingSession = class {
	#restartAttempts = 0;
	#webhookCleared = false;
	#forceRestarted = false;
	#activeRunner;
	#activeFetchAbort;
	#transportState;
	#status;
	#stallThresholdMs;
	constructor(opts) {
		this.opts = opts;
		this.#transportState = new TelegramPollingTransportState({
			log: opts.log,
			initialTransport: opts.telegramTransport,
			createTelegramTransport: opts.createTelegramTransport
		});
		this.#status = createTelegramPollingStatusPublisher(opts.setStatus);
		this.#stallThresholdMs = resolvePollingStallThresholdMs(opts.stallThresholdMs);
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
	async #createPollingBot() {
		const fetchAbortController = new AbortController();
		this.#activeFetchAbort = fetchAbortController;
		const telegramTransport = this.#transportState.acquireForNextCycle();
		const updateOffset = this.opts.isolatedIngress?.enabled ? void 0 : {
			lastUpdateId: this.opts.getLastUpdateId(),
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
	async #drainSpooledUpdates(params) {
		let handled = 0;
		const updates = await listTelegramSpooledUpdates({
			spoolDir: params.spoolDir,
			limit: 100
		});
		for (const update of updates) {
			if (this.opts.abortSignal?.aborted) break;
			try {
				await params.bot.handleUpdate(update.update);
				await deleteTelegramSpooledUpdate(update);
				handled += 1;
			} catch (err) {
				this.opts.log(`[telegram][diag] spooled update ${update.updateId} handler failed; keeping for retry: ${formatErrorMessage(err)}`);
				break;
			}
		}
		return handled;
	}
	async #runIsolatedIngressCycle(bot) {
		const ingress = this.opts.isolatedIngress;
		if (!ingress?.enabled) return this.#runPollingCycle(bot);
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
		this.opts.log(`[telegram][diag] isolated polling ingress started spool=${spoolDir}`);
		const pollState = {
			startedAt: null,
			offset: null,
			outcome: "not-started"
		};
		let consecutiveDrainFailures = 0;
		const unsubscribe = worker.onMessage((message) => {
			if (message.type === "poll-start") {
				pollState.startedAt = message.startedAt;
				pollState.offset = message.offset;
				pollState.outcome = "started";
				delete pollState.error;
				return;
			}
			if (message.type === "poll-success") {
				this.#status.notePollSuccess(message.finishedAt);
				pollState.outcome = `ok:${message.count}`;
				return;
			}
			if (message.type === "poll-error") {
				pollState.outcome = "error";
				pollState.error = message.message;
			}
		});
		const stopOnAbort = () => {
			worker.stop();
		};
		this.opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
		const drainIntervalMs = Math.max(100, Math.floor(ingress.drainIntervalMs ?? 500));
		let drainActive = false;
		const drainOnce = async () => {
			if (drainActive || this.opts.abortSignal?.aborted) return;
			drainActive = true;
			try {
				await this.#drainSpooledUpdates({
					bot,
					spoolDir
				});
				consecutiveDrainFailures = 0;
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
		const stopBot = () => {
			return Promise.resolve(bot.stop()).then(() => void 0).catch(() => {});
		};
		try {
			await worker.task();
			if (this.opts.abortSignal?.aborted) return "exit";
			const errorText = pollState.error ? ` error=${pollState.error}` : "";
			this.opts.log(`[telegram][diag] isolated polling ingress stopped outcome=${pollState.outcome} startedAt=${pollState.startedAt ?? "n/a"} offset=${pollState.offset ?? "n/a"}${errorText}`);
			return await this.#waitBeforeRestart((delay) => `Telegram isolated polling ingress stopped; restarting in ${delay}.`) ? "continue" : "exit";
		} finally {
			clearInterval(drainTimer);
			unsubscribe();
			this.opts.abortSignal?.removeEventListener("abort", stopOnAbort);
			await worker.stop();
			await drainOnce();
			await waitForGracefulStop(stopBot);
		}
	}
	async #runPollingCycle(bot) {
		const liveness = new TelegramPollingLivenessTracker({ onPollSuccess: (finishedAt) => this.#status.notePollSuccess(finishedAt) });
		bot.api.config.use(async (prev, method, payload, signal) => {
			if (method !== "getUpdates") {
				const callId = liveness.noteApiCallStarted();
				try {
					const result = await prev(method, payload, signal);
					liveness.noteApiCallSuccess();
					return result;
				} finally {
					liveness.noteApiCallFinished(callId);
				}
			}
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
export { TelegramPollingSession, readTelegramUpdateOffset, writeTelegramUpdateOffset };
