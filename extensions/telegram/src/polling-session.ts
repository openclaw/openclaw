import { type RunOptions, run } from "@grammyjs/runner";
import {
  computeBackoff,
  formatDurationPrecise,
  logVerbose,
  sleepWithAbort,
} from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { createTelegramBot } from "./bot.js";
import { type TelegramTransport } from "./fetch.js";
import { isRecoverableTelegramNetworkError, isStaleConnectionError } from "./network-errors.js";
import { TelegramPollingTransportState } from "./polling-transport-state.js";

const TELEGRAM_POLL_RESTART_POLICY = {
  initialMs: 2000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
};

const POLL_STALL_THRESHOLD_MS = 90_000;
const POLL_WATCHDOG_INTERVAL_MS = 30_000;
const POLL_STOP_GRACE_MS = 15_000;

/**
 * Health check interval: how often to ping Telegram API to detect stale connections.
 * After inactivity, NAT/firewalls may silently drop TCP connections, causing the
 * long-polling socket to hang indefinitely. This watchdog detects and recovers from that.
 */
const HEALTH_CHECK_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const HEALTH_CHECK_TIMEOUT_MS = 10 * 1000; // 10 seconds

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

  async #runPollingCycle(bot: TelegramBot): Promise<"continue" | "exit"> {
    await this.#confirmPersistedOffset(bot);

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
    let _stopSequenceLogged = false;
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
    let staleConnectionDetected = false;
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

    const watchdog = setInterval(() => {
      if (this.opts.abortSignal?.aborted) {
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

      // Treat recent non-getUpdates success and recent non-getUpdates start as
      // the same liveness signal. Slow delivery should suppress the watchdog,
      // but only for the same bounded window as recent successful API traffic.
      if (
        elapsed > POLL_STALL_THRESHOLD_MS &&
        apiElapsed > POLL_STALL_THRESHOLD_MS &&
        runner.isRunning()
      ) {
        if (stallDiagLoggedAt && now - stallDiagLoggedAt < POLL_STALL_THRESHOLD_MS / 2) {
          return;
        }
        stallDiagLoggedAt = now;
        this.#transportState.markDirty();
        stalledRestart = true;
        const elapsedLabel =
          inFlightGetUpdates > 0
            ? `active getUpdates stuck for ${formatDurationPrecise(elapsed)}`
            : `no completed getUpdates for ${formatDurationPrecise(elapsed)}`;
        this.opts.log(
          `[telegram] Polling stall detected (${elapsedLabel}); forcing restart. [diag inFlight=${inFlightGetUpdates} outcome=${lastGetUpdatesOutcome} startedAt=${lastGetUpdatesStartedAt ?? "n/a"} finishedAt=${lastGetUpdatesFinishedAt ?? "n/a"} durationMs=${lastGetUpdatesDurationMs ?? "n/a"} offset=${lastGetUpdatesOffset ?? "n/a"}${lastGetUpdatesError ? ` error=${lastGetUpdatesError}` : ""}]`,
        );
        void stopRunner();
        void stopBot();
        if (!forceCycleTimer) {
          forceCycleTimer = setTimeout(() => {
            if (this.opts.abortSignal?.aborted) {
              return;
            }
            this.opts.log(
              `[telegram] Polling runner stop timed out after ${formatDurationPrecise(POLL_STOP_GRACE_MS)}; forcing restart cycle.`,
            );
            forceCycleResolve?.();
          }, POLL_STOP_GRACE_MS);
        }
      }
    }, POLL_WATCHDOG_INTERVAL_MS);

    // Health check watchdog: periodically ping Telegram API to detect stale connections.
    // If the connection is dead (NAT timeout, firewall drop), the health check will fail
    // and we'll restart the runner.
    // Uses a self-scheduling loop instead of setInterval to prevent overlapping checks
    // when a health check takes longer than the interval period.
    // healthCheckStopped guards against a concurrent in-flight check scheduling a new
    // timer after stopHealthCheck() has been called (e.g., during runner teardown).
    let healthCheckStopped = false;
    let healthCheckTimer: ReturnType<typeof setTimeout> | undefined;
    let healthCheckTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const startHealthCheck = () => {
      const scheduleNext = () => {
        healthCheckTimer = setTimeout(async () => {
          if (healthCheckStopped || this.opts.abortSignal?.aborted) {
            return;
          }
          try {
            const timeoutPromise = new Promise<never>((_, reject) => {
              healthCheckTimeoutHandle = setTimeout(
                () => reject(new Error("Health check timeout")),
                HEALTH_CHECK_TIMEOUT_MS,
              );
            });
            try {
              await Promise.race([bot.api.getMe(), timeoutPromise]);
            } finally {
              if (healthCheckTimeoutHandle) {
                clearTimeout(healthCheckTimeoutHandle);
                healthCheckTimeoutHandle = undefined;
              }
            }
            logVerbose("[telegram] Health check passed");
          } catch (err) {
            if (healthCheckStopped || this.opts.abortSignal?.aborted) {
              return;
            }
            // Distinguish connection/network errors from HTTP API responses (429, 5xx).
            // A Telegram HTTP error (e.g. 504 Gateway Timeout) means the server
            // responded -- the TCP connection is alive.  Only actual connection-level
            // failures (ECONNRESET, socket hang up, our own health-check timeout, etc.)
            // should trigger a stale-connection restart.
            if (isStaleConnectionError(err)) {
              staleConnectionDetected = true;
              this.opts.log(
                `[telegram] Health check failed (stale connection detected): ${formatErrorMessage(err)}; restarting polling...`,
              );
              void stopRunner();
              // Arm the forced-cycle fallback so runner.task() cannot hang
              // indefinitely if a slow/hung update handler blocks runner.stop().
              if (!forceCycleTimer) {
                forceCycleTimer = setTimeout(() => {
                  if (this.opts.abortSignal?.aborted) {
                    return;
                  }
                  this.opts.log(
                    `[telegram] Polling runner stop timed out after ${formatDurationPrecise(POLL_STOP_GRACE_MS)} (stale connection restart); forcing restart cycle.`,
                  );
                  forceCycleResolve?.();
                }, POLL_STOP_GRACE_MS);
              }
              return; // Don't schedule next check; runner restart will create a new watchdog
            }
            // Transient API error (e.g. 429 rate-limit, 5xx server error) --
            // log and reschedule; no restart needed.
            this.opts.log(
              `[telegram] Health check transient error: ${formatErrorMessage(err)}; will retry at next interval.`,
            );
          }
          // Only reschedule if watchdog is still active (not torn down mid-check).
          if (!healthCheckStopped) {
            scheduleNext();
          }
        }, HEALTH_CHECK_INTERVAL_MS);
      };
      scheduleNext();
    };

    const stopHealthCheck = () => {
      healthCheckStopped = true;
      if (healthCheckTimer) {
        clearTimeout(healthCheckTimer);
        healthCheckTimer = undefined;
      }
      // Clear the inner timeout handle to avoid keeping the event loop alive
      // for up to HEALTH_CHECK_TIMEOUT_MS after teardown.
      if (healthCheckTimeoutHandle) {
        clearTimeout(healthCheckTimeoutHandle);
        healthCheckTimeoutHandle = undefined;
      }
    };

    this.opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
    startHealthCheck();
    try {
      await Promise.race([runner.task(), forceCyclePromise]);
      if (this.opts.abortSignal?.aborted) {
        return "exit";
      }
      if (staleConnectionDetected) {
        // Runner was stopped due to health check failure; continue to restart
        // without backoff since this is a controlled recovery restart.
        this.#forceRestarted = false;
        this.#restartAttempts = 0;
        return "continue";
      }
      const reason = stalledRestart
        ? "polling stall detected"
        : this.#forceRestarted
          ? "unhandled network error"
          : "runner stopped (maxRetryTime exceeded or graceful stop)";
      this.#forceRestarted = false;
      this.opts.log(
        `[telegram][diag] polling cycle finished reason=${reason} inFlight=${inFlightGetUpdates} outcome=${lastGetUpdatesOutcome} startedAt=${lastGetUpdatesStartedAt ?? "n/a"} finishedAt=${lastGetUpdatesFinishedAt ?? "n/a"} durationMs=${lastGetUpdatesDurationMs ?? "n/a"} offset=${lastGetUpdatesOffset ?? "n/a"}${lastGetUpdatesError ? ` error=${String(lastGetUpdatesError)}` : ""}`,
      );
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
      this.opts.log(
        `[telegram][diag] polling cycle error reason=${reason} inFlight=${inFlightGetUpdates} outcome=${lastGetUpdatesOutcome} startedAt=${lastGetUpdatesStartedAt ?? "n/a"} finishedAt=${lastGetUpdatesFinishedAt ?? "n/a"} durationMs=${lastGetUpdatesDurationMs ?? "n/a"} offset=${lastGetUpdatesOffset ?? "n/a"} err=${errMsg}${lastGetUpdatesError ? ` lastGetUpdatesError=${String(lastGetUpdatesError)}` : ""}`,
      );
      const shouldRestart = await this.#waitBeforeRestart(
        (delay) => `Telegram ${reason}: ${errMsg}; retrying in ${delay}.`,
      );
      return shouldRestart ? "continue" : "exit";
    } finally {
      clearInterval(watchdog);
      stopHealthCheck();
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
    .join(" ");
  const normalizedHaystack = normalizeLowercaseStringOrEmpty(haystack);
  return normalizedHaystack.includes("getupdates");
};
