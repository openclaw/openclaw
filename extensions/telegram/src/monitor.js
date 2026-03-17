import { resolveAgentMaxConcurrent } from "../../../src/config/agent-limits.js";
import { loadConfig } from "../../../src/config/config.js";
import { waitForAbortSignal } from "../../../src/infra/abort-signal.js";
import { formatErrorMessage } from "../../../src/infra/errors.js";
import { registerUnhandledRejectionHandler } from "../../../src/infra/unhandled-rejections.js";
import { resolveTelegramAccount } from "./accounts.js";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";
import { TelegramExecApprovalHandler } from "./exec-approvals-handler.js";
import {
  isRecoverableTelegramNetworkError,
  isTelegramPollingNetworkError
} from "./network-errors.js";
import { TelegramPollingSession } from "./polling-session.js";
import { makeProxyFetch } from "./proxy.js";
import { readTelegramUpdateOffset, writeTelegramUpdateOffset } from "./update-offset-store.js";
import { startTelegramWebhook } from "./webhook.js";
function createTelegramRunnerOptions(cfg) {
  return {
    sink: {
      concurrency: resolveAgentMaxConcurrent(cfg)
    },
    runner: {
      fetch: {
        // Match grammY defaults
        timeout: 30,
        // Request reactions without dropping default update types.
        allowed_updates: resolveTelegramAllowedUpdates()
      },
      // Suppress grammY getUpdates stack traces; we log concise errors ourselves.
      silent: true,
      // Keep grammY retrying for a long outage window. If polling still
      // stops, the outer monitor loop restarts it with backoff.
      maxRetryTime: 60 * 60 * 1e3,
      retryInterval: "exponential"
    }
  };
}
function normalizePersistedUpdateId(value) {
  if (value === null) {
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return value;
}
const isGrammyHttpError = (err) => {
  if (!err || typeof err !== "object") {
    return false;
  }
  return err.name === "HttpError";
};
async function monitorTelegramProvider(opts = {}) {
  const log = opts.runtime?.error ?? console.error;
  let pollingSession;
  let execApprovalsHandler;
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
      pollingSession?.abortActiveFetch();
      void activeRunner.stop().catch(() => {
      });
      log(
        `[telegram] Restarting polling after unhandled network error: ${formatErrorMessage(err)}`
      );
      return true;
    }
    return false;
  });
  try {
    const cfg = opts.config ?? loadConfig();
    const account = resolveTelegramAccount({
      cfg,
      accountId: opts.accountId
    });
    const token = opts.token?.trim() || account.token;
    if (!token) {
      throw new Error(
        `Telegram bot token missing for account "${account.accountId}" (set channels.telegram.accounts.${account.accountId}.botToken/tokenFile or TELEGRAM_BOT_TOKEN for default).`
      );
    }
    const proxyFetch = opts.proxyFetch ?? (account.config.proxy ? makeProxyFetch(account.config.proxy) : void 0);
    execApprovalsHandler = new TelegramExecApprovalHandler({
      token,
      accountId: account.accountId,
      cfg,
      runtime: opts.runtime
    });
    await execApprovalsHandler.start();
    const persistedOffsetRaw = await readTelegramUpdateOffset({
      accountId: account.accountId,
      botToken: token
    });
    let lastUpdateId = normalizePersistedUpdateId(persistedOffsetRaw);
    if (persistedOffsetRaw !== null && lastUpdateId === null) {
      log(
        `[telegram] Ignoring invalid persisted update offset (${String(persistedOffsetRaw)}); starting without offset confirmation.`
      );
    }
    const persistUpdateId = async (updateId) => {
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
          botToken: token
        });
      } catch (err) {
        (opts.runtime?.error ?? console.error)(
          `telegram: failed to persist update offset: ${String(err)}`
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
        runtime: opts.runtime,
        fetch: proxyFetch,
        abortSignal: opts.abortSignal,
        publicUrl: opts.webhookUrl,
        webhookCertPath: opts.webhookCertPath
      });
      await waitForAbortSignal(opts.abortSignal);
      return;
    }
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
      log
    });
    await pollingSession.runUntilAbort();
  } finally {
    await execApprovalsHandler?.stop().catch(() => {
    });
    unregisterHandler();
  }
}
export {
  createTelegramRunnerOptions,
  monitorTelegramProvider
};
