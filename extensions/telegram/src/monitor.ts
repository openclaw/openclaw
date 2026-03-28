import type { RunOptions } from "@grammyjs/runner";
import { resolveAgentMaxConcurrent } from "openclaw/plugin-sdk/config-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { waitForAbortSignal } from "openclaw/plugin-sdk/runtime-env";
import { registerUnhandledRejectionHandler } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveTelegramAccount } from "./accounts.js";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";
import { TelegramExecApprovalHandler } from "./exec-approvals-handler.js";
import { resolveTelegramTransport } from "./fetch.js";
import {
  isRecoverableTelegramNetworkError,
  isTelegramPollingNetworkError,
} from "./network-errors.js";
import { TelegramPollingSession } from "./polling-session.js";
import { makeProxyFetch } from "./proxy.js";
import { readTelegramUpdateOffset, writeTelegramUpdateOffset } from "./update-offset-store.js";
import { startTelegramWebhook } from "./webhook.js";

export type MonitorTelegramOpts = {
  token?: string;
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  useWebhook?: boolean;
  webhookPath?: string;
  webhookPort?: number;
  webhookSecret?: string;
  webhookHost?: string;
  proxyFetch?: typeof fetch;
  webhookUrl?: string;
  webhookCertPath?: string;
};

export function createTelegramRunnerOptions(cfg: OpenClawConfig): RunOptions<unknown> {
  return {
    sink: {
      concurrency: resolveAgentMaxConcurrent(cfg),
    },
    runner: {
      fetch: {
        // Match grammY defaults
        timeout: 30,
        // Request reactions without dropping default update types.
        allowed_updates: resolveTelegramAllowedUpdates(),
      },
      // Suppress grammY getUpdates stack traces; we log concise errors ourselves.
      silent: true,
      // Keep grammY retrying for a long outage window. If polling still
      // stops, the outer monitor loop restarts it with backoff.
      maxRetryTime: 60 * 60 * 1000,
      retryInterval: "exponential",
    },
  };
}

function normalizePersistedUpdateId(value: number | null): number | null {
  if (value === null) {
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return value;
}

/** Check if error is a Grammy HttpError (used to scope unhandled rejection handling) */
const isGrammyHttpError = (err: unknown): boolean => {
  if (!err || typeof err !== "object") {
    return false;
  }
  return (err as { name?: string }).name === "HttpError";
};

/**
 * Per-token registry of active polling sessions. Prevents duplicate pollers
 * for the same bot token, which cause Telegram 409 Conflict errors.
 *
 * When a new session starts for a token that already has an active session,
 * we wait for the previous session to fully release its getUpdates long-poll
 * before proceeding. This handles hot-reload races, external script conflicts,
 * and watchdog restart overlaps where waitForGracefulStop times out.
 *
 * See: https://github.com/openclaw/openclaw/issues/56230
 */
type ActivePollerEntry = {
  accountId: string;
  startedAt: number;
  /** Resolves when this polling session exits (finally block runs). */
  done: Promise<void>;
};

const activePollers = new Map<string, ActivePollerEntry>();

/** Wait timeout for a previous session to release before starting a new one. */
const DUPLICATE_POLLER_DRAIN_MS = 5_000;

export async function monitorTelegramProvider(opts: MonitorTelegramOpts = {}) {
  const log = opts.runtime?.error ?? console.error;
  let pollingSession: TelegramPollingSession | undefined;
  let execApprovalsHandler: TelegramExecApprovalHandler | undefined;

  const unregisterHandler = registerUnhandledRejectionHandler((err) => {
    const isNetworkError = isRecoverableTelegramNetworkError(err, { context: "polling" });
    const isTelegramPollingError = isTelegramPollingNetworkError(err);
    if (isGrammyHttpError(err) && isNetworkError && isTelegramPollingError) {
      log(`[telegram] Suppressed network error: ${formatErrorMessage(err)}`);
      return true;
    }

    const activeRunner = pollingSession?.activeRunner;
    if (isNetworkError && isTelegramPollingError && activeRunner && activeRunner.isRunning()) {
      pollingSession?.markForceRestarted();
      pollingSession?.markTransportDirty();
      pollingSession?.abortActiveFetch();
      void activeRunner.stop().catch(() => {});
      log("[telegram][diag] marking transport dirty after polling network failure");
      log(
        `[telegram] Restarting polling after unhandled network error: ${formatErrorMessage(err)}`,
      );
      return true;
    }

    return false;
  });

  let resolvedToken: string | undefined;
  let resolvedAccountId: string | undefined;
  let resolvePollerDone: (() => void) | undefined;

  try {
    const cfg = opts.config ?? loadConfig();
    const account = resolveTelegramAccount({
      cfg,
      accountId: opts.accountId,
    });
    const token = opts.token?.trim() || account.token;
    if (!token) {
      throw new Error(
        `Telegram bot token missing for account "${account.accountId}" (set channels.telegram.accounts.${account.accountId}.botToken/tokenFile or TELEGRAM_BOT_TOKEN for default).`,
      );
    }

    resolvedToken = token;
    resolvedAccountId = account.accountId;

    // Duplicate-poller guard: if another session is already polling this token,
    // wait for it to release before starting a new one.
    const existing = activePollers.get(token);
    if (existing) {
      const elapsed = Math.round((Date.now() - existing.startedAt) / 1000);
      log(
        `[telegram] [${account.accountId}] waiting for previous polling session to release (duplicate-poller guard; previous started ${elapsed}s ago)`,
      );
      await Promise.race([
        existing.done,
        new Promise<void>((resolve) => setTimeout(resolve, DUPLICATE_POLLER_DRAIN_MS)),
      ]);
      // Clean up stale entry if it's still there after timeout.
      if (activePollers.get(token) === existing) {
        activePollers.delete(token);
      }
    }

    // Register this session in the active poller registry.
    const pollerDone = new Promise<void>((resolve) => {
      resolvePollerDone = resolve;
    });
    activePollers.set(token, {
      accountId: account.accountId,
      startedAt: Date.now(),
      done: pollerDone,
    });

    const proxyFetch =
      opts.proxyFetch ?? (account.config.proxy ? makeProxyFetch(account.config.proxy) : undefined);

    execApprovalsHandler = new TelegramExecApprovalHandler({
      token,
      accountId: account.accountId,
      cfg,
      runtime: opts.runtime,
    });
    await execApprovalsHandler.start();

    const persistedOffsetRaw = await readTelegramUpdateOffset({
      accountId: account.accountId,
      botToken: token,
    });
    let lastUpdateId = normalizePersistedUpdateId(persistedOffsetRaw);
    if (persistedOffsetRaw !== null && lastUpdateId === null) {
      log(
        `[telegram] Ignoring invalid persisted update offset (${String(persistedOffsetRaw)}); starting without offset confirmation.`,
      );
    }

    const persistUpdateId = async (updateId: number) => {
      const normalizedUpdateId = normalizePersistedUpdateId(updateId);
      if (normalizedUpdateId === null) {
        log(`[telegram] Ignoring invalid update_id value: ${String(updateId)}`);
        return;
      }
      if (lastUpdateId !== null && normalizedUpdateId <= lastUpdateId) {
        return;
      }
      lastUpdateId = normalizedUpdateId;
      try {
        await writeTelegramUpdateOffset({
          accountId: account.accountId,
          updateId: normalizedUpdateId,
          botToken: token,
        });
      } catch (err) {
        (opts.runtime?.error ?? console.error)(
          `telegram: failed to persist update offset: ${String(err)}`,
        );
      }
    };

    if (opts.useWebhook) {
      await startTelegramWebhook({
        token,
        accountId: account.accountId,
        config: cfg,
        path: opts.webhookPath,
        port: opts.webhookPort,
        secret: opts.webhookSecret ?? account.config.webhookSecret,
        host: opts.webhookHost ?? account.config.webhookHost,
        runtime: opts.runtime as RuntimeEnv,
        fetch: proxyFetch,
        abortSignal: opts.abortSignal,
        publicUrl: opts.webhookUrl,
        webhookCertPath: opts.webhookCertPath,
      });
      await waitForAbortSignal(opts.abortSignal);
      return;
    }

    // Preserve sticky IPv4 fallback state across clean/conflict restarts.
    // Dirty polling cycles rebuild transport inside TelegramPollingSession.
    const createTelegramTransportForPolling = () =>
      resolveTelegramTransport(proxyFetch, {
        network: account.config.network,
      });
    const telegramTransport = createTelegramTransportForPolling();

    pollingSession = new TelegramPollingSession({
      token,
      config: cfg,
      accountId: account.accountId,
      runtime: opts.runtime,
      proxyFetch,
      abortSignal: opts.abortSignal,
      runnerOptions: createTelegramRunnerOptions(cfg),
      getLastUpdateId: () => lastUpdateId,
      persistUpdateId,
      log,
      telegramTransport,
      createTelegramTransport: createTelegramTransportForPolling,
    });
    await pollingSession.runUntilAbort();
  } finally {
    // Remove this session from the active poller registry and signal completion
    // so any waiting session can proceed.
    if (resolvedToken) {
      const entry = activePollers.get(resolvedToken);
      if (entry && entry.accountId === (resolvedAccountId ?? "default")) {
        activePollers.delete(resolvedToken);
      }
    }
    resolvePollerDone?.();

    await execApprovalsHandler?.stop().catch(() => {});
    unregisterHandler();
  }
}
