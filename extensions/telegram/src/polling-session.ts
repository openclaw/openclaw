import { type RunOptions, run } from "@grammyjs/runner";
import { computeBackoff, sleepWithAbort } from "openclaw/plugin-sdk/infra-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/infra-runtime";
import { formatDurationPrecise } from "openclaw/plugin-sdk/infra-runtime";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { createTelegramBot } from "./bot.js";
import { markTelegramNetworkHealthyFromBot } from "./bot.js";
import { type TelegramTransport } from "./fetch.js";
import { isRecoverableTelegramNetworkError } from "./network-errors.js";

const TELEGRAM_POLL_RESTART_POLICY = {
  initialMs: 2000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
};

const POLL_STALL_THRESHOLD_MS = 90_000;
const TELEGRAM_LONG_POLL_TIMEOUT_MS = 30_000;
const MIN_POLL_STALL_THRESHOLD_MS = TELEGRAM_LONG_POLL_TIMEOUT_MS * 2;
const POLL_WATCHDOG_INTERVAL_MS = 30_000;
const POLL_STOP_GRACE_MS = 15_000;

const resolvePollStallThresholdMs = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return POLL_STALL_THRESHOLD_MS;
  }
  return Math.max(Math.floor(value), MIN_POLL_STALL_THRESHOLD_MS);
};

const resolvePollWatchdogIntervalMs = (pollStallThresholdMs: number): number => {
  const stallBudgetBeyondLongPollMs = Math.max(
    1_000,
    pollStallThresholdMs - TELEGRAM_LONG_POLL_TIMEOUT_MS,
  );
  // For low thresholds (60-89s), poll faster than every 30s so configured
  // recovery windows are not delayed to the next 90s watchdog tick.
  return Math.min(
    POLL_WATCHDOG_INTERVAL_MS,
    Math.max(1_000, Math.floor(stallBudgetBeyondLongPollMs / 3)),
  );
};

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
  /** Polling stall detection threshold in milliseconds. Default: 90_000 */
  pollStallThresholdMs?: number;
};

export class TelegramPollingSession {
  #restartAttempts = 0;
  #webhookCleared = false;
  #forceRestarted = false;
  #outboundRestartSignaled = false;
  #pollCycleCounter = 0;
  #activePollCycleId = 0;
  #activeRunner: ReturnType<typeof run> | undefined;
  #activeFetchAbort: AbortController | undefined;
  #scheduleForceCycleRestart: ((reason: "stall" | "outbound") => void) | undefined;
  #warnedPollStallThresholdClamp = false;

  constructor(private readonly opts: TelegramPollingSessionOpts) {}

  get activeRunner() {
    return this.#activeRunner;
  }

  markForceRestarted() {
    this.#forceRestarted = true;
  }

  abortActiveFetch() {
    this.#activeFetchAbort?.abort();
  }

  signalRecoverableOutboundNetworkError(err: unknown, pollCycleId?: number) {
    if (this.opts.abortSignal?.aborted || this.#outboundRestartSignaled) {
      return;
    }
    if (
      typeof pollCycleId === "number" &&
      (pollCycleId === 0 || this.#activePollCycleId !== pollCycleId)
    ) {
      return;
    }
    const activeRunner = this.#activeRunner;
    if (!activeRunner || !activeRunner.isRunning()) {
      return;
    }
    this.#outboundRestartSignaled = true;
    this.#forceRestarted = true;
    this.opts.log(
      `[telegram] Restarting polling after outbound network error: ${formatErrorMessage(err)}`,
    );
    this.abortActiveFetch();
    this.#scheduleForceCycleRestart?.("outbound");
    void activeRunner.stop().catch(() => {});
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
    const pollCycleId = this.#pollCycleCounter + 1;
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
        telegramTransport: this.opts.telegramTransport,
        onRecoverableSendChatActionNetworkFailure: ({ error }) => {
          this.signalRecoverableOutboundNetworkError(error, pollCycleId);
        },
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
    this.#outboundRestartSignaled = false;
    const pollCycleId = ++this.#pollCycleCounter;
    this.#activePollCycleId = pollCycleId;
    const configuredPollStallThresholdMs = this.opts.pollStallThresholdMs;
    const pollStallThresholdMs = resolvePollStallThresholdMs(this.opts.pollStallThresholdMs);
    const pollWatchdogIntervalMs = resolvePollWatchdogIntervalMs(pollStallThresholdMs);
    if (
      !this.#warnedPollStallThresholdClamp &&
      typeof configuredPollStallThresholdMs === "number" &&
      Number.isFinite(configuredPollStallThresholdMs) &&
      configuredPollStallThresholdMs > 0 &&
      configuredPollStallThresholdMs < MIN_POLL_STALL_THRESHOLD_MS
    ) {
      this.#warnedPollStallThresholdClamp = true;
      this.opts.log(
        `[telegram] channels.telegram.network.pollStallThresholdMs=${Math.floor(configuredPollStallThresholdMs)} is below minimum ${MIN_POLL_STALL_THRESHOLD_MS}; using ${MIN_POLL_STALL_THRESHOLD_MS}.`,
      );
    }

    let lastGetUpdatesAt = Date.now();
    bot.api.config.use(async (prev, method, payload, signal) => {
      if (method !== "getUpdates") {
        return prev(method, payload, signal);
      }
      const result = await prev(method, payload, signal);
      // Refresh stall timing only after a successful long-poll response.
      // Fast failing attempts should not mask prolonged "no successful polls" windows.
      lastGetUpdatesAt = Date.now();
      markTelegramNetworkHealthyFromBot(bot);
      return result;
    });

    const runner = run(bot, this.opts.runnerOptions);
    this.#activeRunner = runner;
    const fetchAbortController = this.#activeFetchAbort;
    let stopPromise: Promise<void> | undefined;
    let stalledRestart = false;
    let forceCycleTimer: ReturnType<typeof setTimeout> | undefined;
    let forceCycleRestarted = false;
    let forceCycleResolve: (() => void) | undefined;
    const forceCyclePromise = new Promise<void>((resolve) => {
      forceCycleResolve = resolve;
    });
    const scheduleForceCycleRestart = (reason: "stall" | "outbound") => {
      if (forceCycleTimer || this.opts.abortSignal?.aborted) {
        return;
      }
      forceCycleTimer = setTimeout(() => {
        if (this.opts.abortSignal?.aborted) {
          return;
        }
        forceCycleRestarted = true;
        const cause =
          reason === "outbound" ? "outbound-triggered polling restart" : "polling stall restart";
        this.opts.log(
          `[telegram] ${cause} timed out after ${formatDurationPrecise(POLL_STOP_GRACE_MS)}; forcing restart cycle.`,
        );
        forceCycleResolve?.();
      }, POLL_STOP_GRACE_MS);
      forceCycleTimer.unref?.();
    };
    this.#scheduleForceCycleRestart = scheduleForceCycleRestart;
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
      const elapsed = Date.now() - lastGetUpdatesAt;
      const hasPendingUpdates =
        typeof runner.size === "function" ? Number(runner.size()) > 0 : false;
      const isPollStalled = elapsed > pollStallThresholdMs && !hasPendingUpdates;
      if (runner.isRunning() && isPollStalled) {
        stalledRestart = true;
        this.opts.log(
          `[telegram] Polling stall detected (no getUpdates for ${formatDurationPrecise(elapsed)}, no pending updates); forcing restart.`,
        );
        void stopRunner();
        void stopBot();
        scheduleForceCycleRestart("stall");
      }
    }, pollWatchdogIntervalMs);

    this.opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
    try {
      await Promise.race([runner.task(), forceCyclePromise]);
      if (this.opts.abortSignal?.aborted) {
        return "exit";
      }
      const reason = stalledRestart
        ? "polling stall detected"
        : this.#forceRestarted
          ? "unhandled network error"
          : "runner stopped (maxRetryTime exceeded or graceful stop)";
      this.#forceRestarted = false;
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
      if (!isConflict && !isRecoverable) {
        throw err;
      }
      const reason = isConflict ? "getUpdates conflict" : "network error";
      const errMsg = formatErrorMessage(err);
      const shouldRestart = await this.#waitBeforeRestart(
        (delay) => `Telegram ${reason}: ${errMsg}; retrying in ${delay}.`,
      );
      return shouldRestart ? "continue" : "exit";
    } finally {
      clearInterval(watchdog);
      if (forceCycleTimer) {
        clearTimeout(forceCycleTimer);
      }
      if (this.#scheduleForceCycleRestart === scheduleForceCycleRestart) {
        this.#scheduleForceCycleRestart = undefined;
      }
      this.opts.abortSignal?.removeEventListener("abort", stopOnAbort);
      if (forceCycleRestarted) {
        // Force-cycle path already waited POLL_STOP_GRACE_MS for stuck stop handlers.
        // Avoid compounding two more grace waits before next-cycle restart.
        void stopRunner();
        void stopBot();
      } else {
        await waitForGracefulStop(stopRunner);
        await waitForGracefulStop(stopBot);
      }
      this.#activeRunner = undefined;
      if (this.#activePollCycleId === pollCycleId) {
        this.#activePollCycleId = 0;
      }
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
