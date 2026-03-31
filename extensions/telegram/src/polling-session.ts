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
const POLL_WATCHDOG_INTERVAL_MS = 30_000;
const POLL_STOP_GRACE_MS = 15_000;
const SUPERVISOR_UPDATES_STALE_THRESHOLD_MS = 90_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const HEARTBEAT_FAIL_THRESHOLD = 3;

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
  /** Pre-resolved API base for lightweight heartbeat probes. */
  apiBase: string;
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
    // The heartbeat supervisor lives across polling cycles.
    // It controls whether polling is allowed to run.
    let heartbeatSuspended = false;
    let heartbeatConsecutiveFailures = 0;
    let currentCycleAbort: AbortController | undefined;
    let heartbeatRecoveryWake = new AbortController();
    const heartbeatStop = new AbortController();
    const heartbeatAborted = () => this.opts.abortSignal?.aborted || heartbeatStop.signal.aborted;

    // Start the heartbeat loop — it runs for the entire session lifetime.
    const heartbeatLoop = (async () => {
      while (!heartbeatAborted()) {
        await sleepWithAbort(HEARTBEAT_INTERVAL_MS, heartbeatStop.signal).catch(() => {});
        if (heartbeatAborted()) return;

        let heartbeat: "ok" | "network-failure" | "fatal-api-failure" = "network-failure";
        try {
          heartbeat = await this.#probeHeartbeatOnce({
            stopSignal: heartbeatStop.signal,
            rebuildTransportIfDirty: heartbeatSuspended,
          });
        } catch (err) {
          const errMsg = formatErrorMessage(err);
          this.opts.log(`[telegram][diag] Heartbeat probe threw before completion: ${errMsg}`);
          heartbeat = "network-failure";
        }
        if (heartbeat === "ok") {
          if (heartbeatConsecutiveFailures > 0) {
            this.opts.log(
              `[telegram] Heartbeat recovered after ${heartbeatConsecutiveFailures} failure(s).`,
            );
          }
          heartbeatConsecutiveFailures = 0;
          if (heartbeatSuspended) {
            heartbeatSuspended = false;
            heartbeatRecoveryWake.abort();
            heartbeatRecoveryWake = new AbortController();
          }
          continue;
        }

        if (heartbeat === "fatal-api-failure") {
          this.opts.log(
            `[telegram] Heartbeat probe hit a fatal API error; releasing heartbeat suspension so the normal fatal path can surface the error.`,
          );
          heartbeatConsecutiveFailures = 0;
          if (heartbeatSuspended) {
            heartbeatSuspended = false;
            heartbeatRecoveryWake.abort();
            heartbeatRecoveryWake = new AbortController();
          }
          continue;
        }

        heartbeatConsecutiveFailures += 1;
        // Transport is already marked dirty when suspension starts (below);
        // re-marking on every subsequent failure would rebuild a new undici
        // transport each heartbeat interval without disposing the previous one,
        // accumulating sockets/agents during prolonged outages.
        if (heartbeatConsecutiveFailures < HEARTBEAT_FAIL_THRESHOLD) {
          this.opts.log(
            `[telegram][diag] Heartbeat failed (${heartbeatConsecutiveFailures}/${HEARTBEAT_FAIL_THRESHOLD}).`,
          );
          continue;
        }

        if (!heartbeatSuspended) {
          this.opts.log(
            `[telegram] Heartbeat failed ${heartbeatConsecutiveFailures} consecutive times; stopping polling and waiting for recovery.`,
          );
          heartbeatSuspended = true;
          this.#transportState.markDirty();
        }
        // Always abort the current polling cycle if one is running.
        currentCycleAbort?.abort();
      }
    })();

    try {
      while (!this.opts.abortSignal?.aborted) {
        // If heartbeat has suspended polling, wait for recovery.
        while (heartbeatSuspended && !this.opts.abortSignal?.aborted) {
          const abortController = new AbortController();
          const onSessionAbort = () => abortController.abort();
          const onRecovery = () => abortController.abort();
          this.opts.abortSignal?.addEventListener("abort", onSessionAbort, { once: true });
          heartbeatRecoveryWake.signal.addEventListener("abort", onRecovery, { once: true });
          if (heartbeatSuspended) {
            await sleepWithAbort(HEARTBEAT_INTERVAL_MS, abortController.signal).catch(() => {});
          }
          this.opts.abortSignal?.removeEventListener("abort", onSessionAbort);
          heartbeatRecoveryWake.signal.removeEventListener("abort", onRecovery);
        }
        if (this.opts.abortSignal?.aborted) return;

        const bot = await this.#createPollingBot();
        if (!bot) continue;

        const cleanupState = await this.#ensureWebhookCleanup(bot);
        if (cleanupState === "retry") continue;
        if (cleanupState === "exit") return;

        // Re-check suspension after async setup to avoid a race window.
        if (heartbeatSuspended || this.opts.abortSignal?.aborted) {
          continue;
        }

        // Give the current cycle an abort controller so the heartbeat can stop it.
        const cycleAbort = new AbortController();
        currentCycleAbort = cycleAbort;

        const state = await this.#runPollingCycle(bot, cycleAbort.signal);
        currentCycleAbort = undefined;

        if (state === "exit") return;
        // "continue" — loop back, will check heartbeatSuspended before starting next cycle.
      }
    } finally {
      // Session ending or fatal error — stop heartbeat loop so runUntilAbort can exit.
      heartbeatStop.abort();
      await heartbeatLoop.catch(() => {});
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

  async #runPollingCycle(
    bot: TelegramBot,
    cycleSignal?: AbortSignal,
  ): Promise<"continue" | "exit"> {
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
    let heartbeatAbortedCycle = false;
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
      const updatesElapsed = now - (lastGetUpdatesFinishedAt ?? lastGetUpdatesAt);
      const updatesStale =
        updatesElapsed > SUPERVISOR_UPDATES_STALE_THRESHOLD_MS &&
        inFlightGetUpdates === 0 &&
        latestInFlightApiStartedAt == null &&
        apiElapsed > SUPERVISOR_UPDATES_STALE_THRESHOLD_MS;

      if (updatesStale && runner.isRunning()) {
        if (stallDiagLoggedAt && now - stallDiagLoggedAt < POLL_STALL_THRESHOLD_MS / 2) {
          return;
        }
        stallDiagLoggedAt = now;
        this.#transportState.markDirty();
        stalledRestart = true;
        this.opts.log(
          `[telegram] Polling freshness check failed (no successful getUpdates for ${formatDurationPrecise(updatesElapsed)} with no in-flight request); forcing restart. [diag inFlight=${inFlightGetUpdates} outcome=${lastGetUpdatesOutcome} startedAt=${lastGetUpdatesStartedAt ?? "n/a"} finishedAt=${lastGetUpdatesFinishedAt ?? "n/a"} durationMs=${lastGetUpdatesDurationMs ?? "n/a"} offset=${lastGetUpdatesOffset ?? "n/a"}${lastGetUpdatesError ? ` error=${lastGetUpdatesError}` : ""}]`,
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
        return;
      }

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

    this.opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });

    // If the outer heartbeat supervisor aborts this cycle, treat it like a stall.
    const onCycleAbort = () => {
      heartbeatAbortedCycle = true;
      void stopRunner();
      void stopBot();
      forceCycleResolve?.();
    };
    if (cycleSignal?.aborted) {
      onCycleAbort();
    } else {
      cycleSignal?.addEventListener("abort", onCycleAbort, { once: true });
    }

    try {
      await Promise.race([runner.task(), forceCyclePromise]);
      if (this.opts.abortSignal?.aborted) {
        return "exit";
      }
      const reason = heartbeatAbortedCycle
        ? "heartbeat abort"
        : stalledRestart
          ? "polling stall detected"
          : this.#forceRestarted
            ? "unhandled network error"
            : "runner stopped (maxRetryTime exceeded or graceful stop)";
      this.#forceRestarted = false;
      this.opts.log(
        `[telegram][diag] polling cycle finished reason=${reason} inFlight=${inFlightGetUpdates} outcome=${lastGetUpdatesOutcome} startedAt=${lastGetUpdatesStartedAt ?? "n/a"} finishedAt=${lastGetUpdatesFinishedAt ?? "n/a"} durationMs=${lastGetUpdatesDurationMs ?? "n/a"} offset=${lastGetUpdatesOffset ?? "n/a"}${lastGetUpdatesError ? ` error=${lastGetUpdatesError}` : ""}`,
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
        `[telegram][diag] polling cycle error reason=${reason} inFlight=${inFlightGetUpdates} outcome=${lastGetUpdatesOutcome} startedAt=${lastGetUpdatesStartedAt ?? "n/a"} finishedAt=${lastGetUpdatesFinishedAt ?? "n/a"} durationMs=${lastGetUpdatesDurationMs ?? "n/a"} offset=${lastGetUpdatesOffset ?? "n/a"} err=${errMsg}${lastGetUpdatesError ? ` lastGetUpdatesError=${lastGetUpdatesError}` : ""}`,
      );
      const shouldRestart = await this.#waitBeforeRestart(
        (delay) => `Telegram ${reason}: ${errMsg}; retrying in ${delay}.`,
      );
      return shouldRestart ? "continue" : "exit";
    } finally {
      cycleSignal?.removeEventListener("abort", onCycleAbort);
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

  /**
   * Lightweight heartbeat probe using the same transport as polling
   * (respects forceIpv4, DNS tuning, proxy, sticky fallback, etc.).
   * Returns true on success, false on failure.
   */
  async #probeHeartbeatOnce(params?: {
    stopSignal?: AbortSignal;
    rebuildTransportIfDirty?: boolean;
  }): Promise<"ok" | "network-failure" | "fatal-api-failure"> {
    const url = `${this.opts.apiBase}/bot${this.opts.token}/getMe`;
    const transport = params?.rebuildTransportIfDirty
      ? this.#transportState.acquireForHeartbeatProbe()
      : this.#transportState.currentTransport();
    const fetchImpl = transport?.fetch ?? this.opts.proxyFetch ?? globalThis.fetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEARTBEAT_TIMEOUT_MS);
    timeout.unref?.();
    const onSessionAbort = () => controller.abort();
    const onStopAbort = () => controller.abort();
    this.opts.abortSignal?.addEventListener("abort", onSessionAbort, { once: true });
    params?.stopSignal?.addEventListener("abort", onStopAbort, { once: true });
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: controller.signal,
      });
      const status = response.status;
      await response.body?.cancel().catch(() => {});
      if (response.ok) {
        return "ok";
      }
      if (status >= 400 && status < 500) {
        return "fatal-api-failure";
      }
      return "network-failure";
    } catch {
      return "network-failure";
    } finally {
      clearTimeout(timeout);
      this.opts.abortSignal?.removeEventListener("abort", onSessionAbort);
      params?.stopSignal?.removeEventListener("abort", onStopAbort);
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
