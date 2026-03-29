import { type RunOptions, run } from "@grammyjs/runner";
import {
  computeBackoff,
  formatDurationPrecise,
  sleepWithAbort,
} from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { createTelegramBot } from "./bot.js";
import { resolveTelegramApiBase, type TelegramTransport } from "./fetch.js";
import { isRecoverableTelegramNetworkError } from "./network-errors.js";
import { TelegramPollingTransportState } from "./polling-transport-state.js";

const TELEGRAM_POLL_RESTART_POLICY = {
  initialMs: 2000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
};

const POLL_STALL_THRESHOLD_MS = 90_000;
const POLL_WATCHDOG_INTERVAL_MS = 5_000;
const POLL_STOP_GRACE_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;
const HEARTBEAT_FAIL_THRESHOLD = 3;
const SUPERVISOR_UPDATES_STALE_THRESHOLD_MS = 45_000;

const waitForGracefulStop = async (stop: () => Promise<void>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      stop(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, POLL_STOP_GRACE_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

type TelegramBot = ReturnType<typeof createTelegramBot>;

type TelegramPollingSessionOpts = {
  token: string;
  config: Parameters<typeof createTelegramBot>[0]["config"];
  accountId: string;
  runtime: Parameters<typeof createTelegramBot>[0]["runtime"];
  proxyFetch: Parameters<typeof createTelegramBot>[0]["proxyFetch"];
  abortSignal?: AbortSignal;
  runnerOptions: RunOptions<unknown>;
  getLastUpdateId: () => number | null;
  persistUpdateId: (updateId: number) => Promise<void>;
  log: (line: string) => void;
  /** Pre-resolved Telegram transport to reuse across bot instances */
  telegramTransport?: TelegramTransport;
  /** Rebuild Telegram transport after stall/network recovery when marked dirty. */
  createTelegramTransport?: () => TelegramTransport;
};

export class TelegramPollingSession {
  #restartAttempts = 0;
  #webhookCleared = false;
  #forceRestarted = false;
  #activeRunner: ReturnType<typeof run> | undefined;
  #activeFetchAbort: AbortController | undefined;
  #transportState: TelegramPollingTransportState;
  #stallDetectedAt: number | null = null;
  #stallRecoveryLogged = false;
  #lastHeartbeatOkAt = Date.now();
  #lastUpdatesOkAt = Date.now();
  #heartbeatFailCount = 0;
  #heartbeatProbeInFlight = false;
  #waitingForHeartbeatRecovery = false;

  constructor(private readonly opts: TelegramPollingSessionOpts) {
    this.#transportState = new TelegramPollingTransportState({
      log: opts.log,
      initialTransport: opts.telegramTransport,
      createTelegramTransport: opts.createTelegramTransport,
    });
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

  async runUntilAbort(): Promise<void> {
    while (!this.opts.abortSignal?.aborted) {
      if (this.#waitingForHeartbeatRecovery) {
        const heartbeatFetch =
          this.#transportState.acquireForNextCycle()?.fetch ??
          this.opts.proxyFetch ??
          globalThis.fetch;
        const heartbeat = await this.#probeHeartbeatOnce(heartbeatFetch, { quietFailure: true });
        if (heartbeat === "fatal") {
          return;
        }
        if (heartbeat !== "ok") {
          try {
            await sleepWithAbort(HEARTBEAT_INTERVAL_MS, this.opts.abortSignal);
          } catch {
            return;
          }
          continue;
        }
        this.#waitingForHeartbeatRecovery = false;
        console.info("[telegram] Heartbeat recovered; starting polling instance.");
      }

      const bot = await this.#createPollingBot();
      if (!bot) {
        continue;
      }

      const cleanupState = await this.#ensureWebhookCleanup(bot);
      if (cleanupState === "retry") {
        continue;
      }
      if (cleanupState === "exit") {
        return;
      }

      const state = await this.#runPollingCycle(bot);
      if (state === "exit") {
        return;
      }
    }
  }

  async #waitBeforeRestart(buildLine: (delay: string) => string): Promise<boolean> {
    this.#restartAttempts += 1;
    const delayMs = computeBackoff(TELEGRAM_POLL_RESTART_POLICY, this.#restartAttempts);
    const delay = formatDurationPrecise(delayMs);
    this.opts.log(buildLine(delay));
    try {
      await sleepWithAbort(delayMs, this.opts.abortSignal);
    } catch (sleepErr) {
      if (this.opts.abortSignal?.aborted) {
        return false;
      }
      throw sleepErr;
    }
    return true;
  }

  async #waitBeforeRetryOnRecoverableSetupError(err: unknown, logPrefix: string): Promise<boolean> {
    if (this.opts.abortSignal?.aborted) {
      return false;
    }
    if (!isRecoverableTelegramNetworkError(err, { context: "unknown" })) {
      throw err;
    }
    return this.#waitBeforeRestart(
      (delay) => `${logPrefix}: ${formatErrorMessage(err)}; retrying in ${delay}.`,
    );
  }

  async #createPollingBot(): Promise<TelegramBot | undefined> {
    const fetchAbortController = new AbortController();
    this.#activeFetchAbort = fetchAbortController;
    const telegramTransport = this.#transportState.acquireForNextCycle();
    try {
      return createTelegramBot({
        token: this.opts.token,
        runtime: this.opts.runtime,
        proxyFetch: this.opts.proxyFetch,
        config: this.opts.config,
        accountId: this.opts.accountId,
        fetchAbortSignal: fetchAbortController.signal,
        updateOffset: {
          lastUpdateId: this.opts.getLastUpdateId(),
          onUpdateId: this.opts.persistUpdateId,
        },
        telegramTransport,
      });
    } catch (err) {
      await this.#waitBeforeRetryOnRecoverableSetupError(err, "Telegram setup network error");
      if (this.#activeFetchAbort === fetchAbortController) {
        this.#activeFetchAbort = undefined;
      }
      return undefined;
    }
  }

  async #ensureWebhookCleanup(bot: TelegramBot): Promise<"ready" | "retry" | "exit"> {
    if (this.#webhookCleared) {
      return "ready";
    }
    try {
      await withTelegramApiErrorLogging({
        operation: "deleteWebhook",
        runtime: this.opts.runtime,
        fn: () => bot.api.deleteWebhook({ drop_pending_updates: false }),
      });
      this.#webhookCleared = true;
      return "ready";
    } catch (err) {
      const shouldRetry = await this.#waitBeforeRetryOnRecoverableSetupError(
        err,
        "Telegram webhook cleanup failed",
      );
      return shouldRetry ? "retry" : "exit";
    }
  }

  async #confirmPersistedOffset(bot: TelegramBot): Promise<void> {
    const lastUpdateId = this.opts.getLastUpdateId();
    if (lastUpdateId === null || lastUpdateId >= Number.MAX_SAFE_INTEGER) {
      return;
    }
    try {
      await bot.api.getUpdates({ offset: lastUpdateId + 1, limit: 1, timeout: 0 });
    } catch {
      // Non-fatal: runner middleware still skips duplicates via shouldSkipUpdate.
    }
  }

  async #probeHeartbeatOnce(
    fetchFn: typeof fetch,
    opts?: { quietFailure?: boolean },
  ): Promise<"ok" | "retry" | "fatal"> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), HEARTBEAT_TIMEOUT_MS);
    try {
      const apiRoot =
        this.opts.config && typeof this.opts.config === "object"
          ? ((
              this.opts.config as {
                plugins?: { entries?: { telegram?: { config?: { apiRoot?: string } } } };
              }
            ).plugins?.entries?.telegram?.config?.apiRoot ?? undefined)
          : undefined;
      const apiBase = resolveTelegramApiBase(apiRoot);
      const res = await fetchFn(`${apiBase}/bot${this.opts.token}/getMe`, {
        method: "GET",
        signal: abort.signal,
      });
      if (res.ok) {
        if (this.#heartbeatFailCount > 0) {
          console.debug(
            `[telegram] Heartbeat recovered after ${this.#heartbeatFailCount} consecutive failure(s).`,
          );
        }
        this.#lastHeartbeatOkAt = Date.now();
        this.#heartbeatFailCount = 0;
        return "ok";
      }
      if (res.status === 401 || res.status === 403) {
        console.error(
          `[telegram] Heartbeat failed with non-recoverable status=${res.status}; exiting polling session.`,
        );
        return "fatal";
      }
      this.#heartbeatFailCount += 1;
      if (!opts?.quietFailure) {
        console.debug(
          `[telegram] Heartbeat failed (${this.#heartbeatFailCount}/${HEARTBEAT_FAIL_THRESHOLD}) status=${res.status}.`,
        );
      }
      return "retry";
    } catch (err) {
      this.#heartbeatFailCount += 1;
      if (!opts?.quietFailure) {
        console.debug(
          `[telegram] Heartbeat failed (${this.#heartbeatFailCount}/${HEARTBEAT_FAIL_THRESHOLD}) err=${formatErrorMessage(err)}.`,
        );
      }
      return "retry";
    } finally {
      clearTimeout(timer);
    }
  }

  async #runPollingCycle(bot: TelegramBot): Promise<"continue" | "exit"> {
    await this.#confirmPersistedOffset(bot);
    this.#lastHeartbeatOkAt = Date.now();
    this.#lastUpdatesOkAt = Date.now();
    this.#heartbeatFailCount = 0;

    let lastGetUpdatesAt = Date.now();
    let lastApiActivityAt = Date.now();
    let nextInFlightApiCallId = 0;
    let latestInFlightApiStartedAt: number | null = null;
    const inFlightApiStartedAt = new Map<number, number>();
    let lastGetUpdatesStartedAt: number | null = null;
    let lastGetUpdatesFinishedAt: number | null = null;
    let lastGetUpdatesDurationMs: number | null = null;
    let lastGetUpdatesOutcome = "not-started";
    let lastGetUpdatesError: string | null = null;
    let lastGetUpdatesOffset: number | null = null;
    let inFlightGetUpdates = 0;
    let stopSequenceLogged = false;
    let stallDiagLoggedAt = 0;

    bot.api.config.use(async (prev, method, payload, signal) => {
      if (method !== "getUpdates") {
        const startedAt = Date.now();
        const callId = nextInFlightApiCallId;
        nextInFlightApiCallId += 1;
        inFlightApiStartedAt.set(callId, startedAt);
        latestInFlightApiStartedAt =
          latestInFlightApiStartedAt == null
            ? startedAt
            : Math.max(latestInFlightApiStartedAt, startedAt);
        try {
          const result = await prev(method, payload, signal);
          lastApiActivityAt = Date.now();
          return result;
        } finally {
          inFlightApiStartedAt.delete(callId);
          if (latestInFlightApiStartedAt === startedAt) {
            let newestStartedAt: number | null = null;
            for (const activeStartedAt of inFlightApiStartedAt.values()) {
              newestStartedAt =
                newestStartedAt == null
                  ? activeStartedAt
                  : Math.max(newestStartedAt, activeStartedAt);
            }
            latestInFlightApiStartedAt = newestStartedAt;
          }
        }
      }

      const startedAt = Date.now();
      lastGetUpdatesAt = startedAt;
      lastGetUpdatesStartedAt = startedAt;
      lastGetUpdatesOffset =
        payload && typeof payload === "object" && "offset" in payload
          ? ((payload as { offset?: number }).offset ?? null)
          : null;
      inFlightGetUpdates += 1;
      lastGetUpdatesOutcome = "started";
      lastGetUpdatesError = null;

      try {
        const result = await prev(method, payload, signal);
        const finishedAt = Date.now();
        lastGetUpdatesFinishedAt = finishedAt;
        lastGetUpdatesDurationMs = finishedAt - startedAt;
        lastGetUpdatesOutcome = Array.isArray(result) ? `ok:${result.length}` : "ok";
        this.#lastUpdatesOkAt = finishedAt;
        if (this.#stallDetectedAt != null && !this.#stallRecoveryLogged) {
          this.#stallRecoveryLogged = true;
          const outageMs = finishedAt - this.#stallDetectedAt;
          this.#stallDetectedAt = null;
          console.info(
            `[telegram] Polling recovered after stall; first getUpdates succeeded after ${formatDurationPrecise(outageMs)}. [diag outcome=${lastGetUpdatesOutcome} durationMs=${lastGetUpdatesDurationMs ?? "n/a"} offset=${lastGetUpdatesOffset ?? "n/a"}]`,
          );
        }
        return result;
      } catch (err) {
        const finishedAt = Date.now();
        lastGetUpdatesFinishedAt = finishedAt;
        lastGetUpdatesDurationMs = finishedAt - startedAt;
        lastGetUpdatesOutcome = "error";
        lastGetUpdatesError = formatErrorMessage(err);
        throw err;
      } finally {
        inFlightGetUpdates = Math.max(0, inFlightGetUpdates - 1);
      }
    });

    const heartbeatFetch =
      this.#transportState.acquireForNextCycle()?.fetch ?? this.opts.proxyFetch ?? globalThis.fetch;

    const runner = run(bot, this.opts.runnerOptions);
    this.#activeRunner = runner;
    const fetchAbortController = this.#activeFetchAbort;
    const abortFetch = () => {
      fetchAbortController?.abort();
    };

    if (this.opts.abortSignal && fetchAbortController) {
      this.opts.abortSignal.addEventListener("abort", abortFetch, { once: true });
    }
    let stopPromise: Promise<void> | undefined;
    let stalledRestart = false;
    let forceCycleTimer: ReturnType<typeof setTimeout> | undefined;
    let forceCycleResolve: (() => void) | undefined;
    const forceCyclePromise = new Promise<void>((resolve) => {
      forceCycleResolve = resolve;
    });
    const stopRunner = () => {
      fetchAbortController?.abort();
      stopPromise ??= Promise.resolve(runner.stop())
        .then(() => undefined)
        .catch(() => {
          // Runner may already be stopped by abort/retry paths.
        });
      return stopPromise;
    };
    const stopBot = () => {
      return Promise.resolve(bot.stop())
        .then(() => undefined)
        .catch(() => {
          // Bot may already be stopped by runner stop/abort paths.
        });
    };
    const stopOnAbort = () => {
      if (this.opts.abortSignal?.aborted) {
        void stopRunner();
      }
    };

    const stopForRecovery = (reason: string) => {
      if (!runner.isRunning()) {
        return;
      }
      this.#waitingForHeartbeatRecovery = true;
      triggerSupervisorRestart(reason);
    };

    const triggerSupervisorRestart = (reason: string) => {
      if (!runner.isRunning()) {
        return;
      }
      const now = Date.now();
      if (stallDiagLoggedAt && now - stallDiagLoggedAt < HEARTBEAT_INTERVAL_MS) {
        return;
      }
      stallDiagLoggedAt = now;
      this.#stallDetectedAt ??= now;
      this.#stallRecoveryLogged = false;
      this.#transportState.markDirty();
      stalledRestart = true;
      console.error(
        `[telegram] Polling supervisor stopping polling instance (${reason}). [diag inFlight=${inFlightGetUpdates} outcome=${lastGetUpdatesOutcome} startedAt=${lastGetUpdatesStartedAt ?? "n/a"} finishedAt=${lastGetUpdatesFinishedAt ?? "n/a"} durationMs=${lastGetUpdatesDurationMs ?? "n/a"} offset=${lastGetUpdatesOffset ?? "n/a"} hbFailCnt=${this.#heartbeatFailCount} hbAgeMs=${Date.now() - this.#lastHeartbeatOkAt} updatesAgeMs=${Date.now() - this.#lastUpdatesOkAt}${lastGetUpdatesError ? ` error=${lastGetUpdatesError}` : ""}]`,
      );
      void stopRunner();
      void stopBot();
      if (!forceCycleTimer) {
        forceCycleTimer = setTimeout(() => {
          if (this.opts.abortSignal?.aborted) {
            return;
          }
          console.warn(
            `[telegram] Polling runner stop timed out after ${formatDurationPrecise(POLL_STOP_GRACE_MS)}; forcing restart cycle.`,
          );
          forceCycleResolve?.();
        }, POLL_STOP_GRACE_MS);
      }
    };

    const heartbeat = setInterval(() => {
      if (
        this.opts.abortSignal?.aborted ||
        !runner.isRunning() ||
        this.#waitingForHeartbeatRecovery
      ) {
        return;
      }
      if (this.#heartbeatProbeInFlight) {
        return;
      }
      this.#heartbeatProbeInFlight = true;
      void this.#probeHeartbeatOnce(heartbeatFetch)
        .then((heartbeat) => {
          if (heartbeat === "fatal") {
            this.#waitingForHeartbeatRecovery = false;
            this.#forceRestarted = false;
            void stopRunner();
            void stopBot();
            return;
          }
          if (heartbeat !== "ok" && this.#heartbeatFailCount >= HEARTBEAT_FAIL_THRESHOLD) {
            stopForRecovery(`${this.#heartbeatFailCount} consecutive heartbeat failures`);
          }
        })
        .finally(() => {
          this.#heartbeatProbeInFlight = false;
        });
    }, HEARTBEAT_INTERVAL_MS);

    const watchdog = setInterval(() => {
      if (this.opts.abortSignal?.aborted || !runner.isRunning()) {
        return;
      }

      const now = Date.now();
      const activeElapsed =
        inFlightGetUpdates > 0 && lastGetUpdatesStartedAt != null
          ? now - lastGetUpdatesStartedAt
          : 0;
      const idleElapsed =
        inFlightGetUpdates > 0 ? 0 : now - (lastGetUpdatesFinishedAt ?? lastGetUpdatesAt);
      const elapsed = inFlightGetUpdates > 0 ? activeElapsed : idleElapsed;
      const apiLivenessAt =
        latestInFlightApiStartedAt == null
          ? lastApiActivityAt
          : Math.max(lastApiActivityAt, latestInFlightApiStartedAt);
      const apiElapsed = now - apiLivenessAt;
      const updatesElapsed = now - this.#lastUpdatesOkAt;
      const pollingStalled =
        elapsed > POLL_STALL_THRESHOLD_MS && apiElapsed > POLL_STALL_THRESHOLD_MS;
      const updatesStale = updatesElapsed > SUPERVISOR_UPDATES_STALE_THRESHOLD_MS;

      if (updatesStale) {
        stopForRecovery(`no successful getUpdates for ${formatDurationPrecise(updatesElapsed)}`);
        return;
      }

      if (pollingStalled) {
        triggerSupervisorRestart(
          inFlightGetUpdates > 0
            ? `active getUpdates stuck for ${formatDurationPrecise(elapsed)}`
            : `no completed getUpdates for ${formatDurationPrecise(elapsed)}`,
        );
      }
    }, POLL_WATCHDOG_INTERVAL_MS);

    this.opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
    try {
      await Promise.race([runner.task(), forceCyclePromise]);
      if (this.opts.abortSignal?.aborted) {
        return "exit";
      }
      const reason = stalledRestart
        ? "supervisor restart"
        : this.#forceRestarted
          ? "unhandled network error"
          : "runner stopped (maxRetryTime exceeded or graceful stop)";
      this.#forceRestarted = false;
      console.debug(
        `[telegram][diag] polling cycle finished reason=${reason} inFlight=${inFlightGetUpdates} outcome=${lastGetUpdatesOutcome} startedAt=${lastGetUpdatesStartedAt ?? "n/a"} finishedAt=${lastGetUpdatesFinishedAt ?? "n/a"} durationMs=${lastGetUpdatesDurationMs ?? "n/a"} offset=${lastGetUpdatesOffset ?? "n/a"}${lastGetUpdatesError ? ` error=${lastGetUpdatesError}` : ""}`,
      );
      if (this.#waitingForHeartbeatRecovery) {
        return "continue";
      }
      const shouldRestart = await this.#waitBeforeRestart(
        (delay) => `Telegram polling runner stopped (${reason}); restarting in ${delay}.`,
      );
      return shouldRestart ? "continue" : "exit";
    } catch (err) {
      this.#forceRestarted = false;
      if (this.opts.abortSignal?.aborted) {
        throw err;
      }
      const isConflict = isGetUpdatesConflict(err);
      if (isConflict) {
        this.#webhookCleared = false;
      }
      const isRecoverable = isRecoverableTelegramNetworkError(err, { context: "polling" });
      if (isRecoverable) {
        this.#transportState.markDirty();
      }
      if (!isConflict && !isRecoverable) {
        throw err;
      }
      const reason = isConflict ? "getUpdates conflict" : "network error";
      const errMsg = formatErrorMessage(err);
      console.debug(
        `[telegram][diag] polling cycle error reason=${reason} inFlight=${inFlightGetUpdates} outcome=${lastGetUpdatesOutcome} startedAt=${lastGetUpdatesStartedAt ?? "n/a"} finishedAt=${lastGetUpdatesFinishedAt ?? "n/a"} durationMs=${lastGetUpdatesDurationMs ?? "n/a"} offset=${lastGetUpdatesOffset ?? "n/a"} err=${errMsg}${lastGetUpdatesError ? ` lastGetUpdatesError=${lastGetUpdatesError}` : ""}`,
      );
      const shouldRestart = await this.#waitBeforeRestart(
        (delay) => `Telegram ${reason}: ${errMsg}; retrying in ${delay}.`,
      );
      return shouldRestart ? "continue" : "exit";
    } finally {
      clearInterval(heartbeat);
      clearInterval(watchdog);
      if (forceCycleTimer) {
        clearTimeout(forceCycleTimer);
      }
      this.opts.abortSignal?.removeEventListener("abort", abortFetch);
      this.opts.abortSignal?.removeEventListener("abort", stopOnAbort);
      await waitForGracefulStop(stopRunner);
      await waitForGracefulStop(stopBot);
      this.#activeRunner = undefined;
      if (this.#activeFetchAbort === fetchAbortController) {
        this.#activeFetchAbort = undefined;
      }
    }
  }
}

const isGetUpdatesConflict = (err: unknown) => {
  if (!err || typeof err !== "object") {
    return false;
  }
  const typed = err as {
    error_code?: number;
    errorCode?: number;
    description?: string;
    method?: string;
    message?: string;
  };
  const errorCode = typed.error_code ?? typed.errorCode;
  if (errorCode !== 409) {
    return false;
  }
  const haystack = [typed.method, typed.description, typed.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return haystack.includes("getupdates");
};
