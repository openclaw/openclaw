import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import { makeProxyFetch } from "openclaw/plugin-sdk/fetch-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { waitForAbortSignal } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveTelegramAccountOwnerAgentId } from "./account-owner.js";
import { resolveTelegramAccount } from "./accounts.js";
import { isTelegramExecApprovalHandlerConfigured } from "./exec-approvals.js";
import { resolveTelegramTransport } from "./fetch.js";
import type { MonitorTelegramOpts } from "./monitor.types.js";
import { acquireTelegramPollingLease } from "./polling-lease.js";
import { getTelegramRuntime } from "./runtime.js";
import {
  createTelegramUpdateOffsetPersistence,
  normalizeTelegramUpdateId,
} from "./update-offset-persistence.js";
import type {
  TelegramOffsetRotationReason,
  TelegramUpdateOffsetRotationInfo,
} from "./update-offset-store.js";

const TELEGRAM_OFFSET_ROTATION_LABELS: Record<TelegramOffsetRotationReason, string> = {
  "bot-id-changed": "bot identity change",
  "legacy-state": "legacy update offset",
  "token-rotated": "token rotation",
};

function formatTelegramOffsetRotationMessage(
  accountId: string,
  info: TelegramUpdateOffsetRotationInfo,
): string {
  const previousLabel = info.previousBotId ?? "(legacy unscoped offset)";
  const reasonLabel = TELEGRAM_OFFSET_ROTATION_LABELS[info.reason];
  return `[telegram] Detected ${reasonLabel} for account "${accountId}" (was ${previousLabel}, now ${info.currentBotId}); discarding stale update offset ${info.staleLastUpdateId} and starting fresh.`;
}

const loadTelegramMonitorPollingRuntime = createLazyRuntimeModule(
  () => import("./monitor-polling.runtime.js"),
);

const loadTelegramMonitorWebhookRuntime = createLazyRuntimeModule(() => import("./webhook.js"));

export async function monitorTelegramProvider(opts: MonitorTelegramOpts = {}) {
  const logInfo = (line: string) => (opts.runtime?.log ?? console.log)(line);
  const logError = (line: string) => (opts.runtime?.error ?? console.error)(line);
  const log = (line: string) => {
    if (line.includes("[telegram][diag]")) {
      logInfo(line);
      return;
    }
    logError(line);
  };
  const cfg = opts.config ?? getRuntimeConfig();
  const account = resolveTelegramAccount({
    cfg,
    accountId: opts.accountId,
  });
  const ownerAgentId =
    opts.ownerAgentId?.trim() ||
    resolveTelegramAccountOwnerAgentId({ cfg, accountId: account.accountId });
  const token = opts.token?.trim() || account.token;
  if (!token) {
    throw new Error(
      `Telegram bot token missing for account "${account.accountId}" (set channels.telegram.accounts.${account.accountId}.botToken/tokenFile or TELEGRAM_BOT_TOKEN for default).`,
    );
  }

  const proxyFetch =
    opts.proxyFetch ?? (account.config.proxy ? makeProxyFetch(account.config.proxy) : undefined);

  // SAFETY: Gateway startup supplies the full plugin channel runtime; the surface type is the minimal external view.
  const pluginChannelRuntime = opts.channelRuntime as PluginRuntime["channel"] | undefined;

  if (opts.useWebhook) {
    const { startTelegramWebhook } = await loadTelegramMonitorWebhookRuntime();
    if (isTelegramExecApprovalHandlerConfigured({ cfg, accountId: account.accountId })) {
      registerChannelRuntimeContext({
        channelRuntime: opts.channelRuntime,
        channelId: "telegram",
        accountId: account.accountId,
        capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
        context: { token },
        abortSignal: opts.abortSignal,
      });
    }
    const webhook = await startTelegramWebhook({
      token,
      accountId: account.accountId,
      ownerAgentId,
      config: cfg,
      path: opts.webhookPath,
      legacyWebhook: opts.legacyWebhook ?? account.config.legacyWebhook,
      secret: opts.webhookSecret ?? account.config.webhookSecret,
      runtime: opts.runtime as RuntimeEnv,
      buildContext: pluginChannelRuntime?.inbound.buildContext,
      // Forward the owning runtime's bound dispatcher into the turn plan; never invoked here.
      dispatchReplyFromConfig: pluginChannelRuntime?.reply?.dispatchReplyFromConfig,
      fetch: proxyFetch,
      abortSignal: opts.abortSignal,
      publicUrl: opts.webhookUrl ?? account.config.webhookUrl,
      webhookCertPath: opts.webhookCertPath,
      setStatus: opts.setStatus,
    });
    try {
      await waitForAbortSignal(opts.abortSignal);
    } finally {
      await webhook.stop();
    }
    return;
  }

  const {
    TelegramPollingSession,
    deleteTelegramUpdateOffset,
    readTelegramUpdateOffset,
    writeTelegramUpdateOffset,
  } = await loadTelegramMonitorPollingRuntime();

  const pollingLease = await acquireTelegramPollingLease({
    token,
    accountId: account.accountId,
    abortSignal: opts.abortSignal,
  });
  if (pollingLease.waitedForPrevious) {
    log(
      `[telegram][diag] waited for previous polling session for bot token ${pollingLease.tokenFingerprint} before starting account "${account.accountId}".`,
    );
  }
  if (pollingLease.replacedStoppingPrevious) {
    log(
      `[telegram][diag] previous polling session for bot token ${pollingLease.tokenFingerprint} did not stop within the lease wait; starting a replacement for account "${account.accountId}".`,
    );
  }

  try {
    if (isTelegramExecApprovalHandlerConfigured({ cfg, accountId: account.accountId })) {
      registerChannelRuntimeContext({
        channelRuntime: opts.channelRuntime,
        channelId: "telegram",
        accountId: account.accountId,
        capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
        context: { token },
        abortSignal: opts.abortSignal,
      });
    }

    const persistedOffsetRaw = await readTelegramUpdateOffset({
      accountId: account.accountId,
      botToken: token,
      onRotationDetected: async (info) => {
        log(formatTelegramOffsetRotationMessage(account.accountId, info));
        try {
          if (info.previousBotId !== null && info.previousBotId !== info.currentBotId) {
            const queue = getTelegramRuntime().state.openChannelIngressQueue({
              accountId: account.accountId,
            });
            if (!queue.purge) {
              throw new Error(
                "The host does not support ingress identity resets; update OpenClaw.",
              );
            }
            opts.abortSignal?.throwIfAborted();
            await queue.purge();
          }
          // An abort keeps the old identity so the next start re-detects and repeats the purge.
          opts.abortSignal?.throwIfAborted();
          await deleteTelegramUpdateOffset({ accountId: account.accountId });
        } catch (err) {
          throw new Error(
            `telegram: failed to reset ingress for account "${account.accountId}" after rotation; restart the account to retry: ${formatErrorMessage(err)}`,
            { cause: err },
          );
        }
      },
    });
    const lastUpdateId = normalizeTelegramUpdateId(persistedOffsetRaw);
    if (persistedOffsetRaw !== null && lastUpdateId === null) {
      log(
        `[telegram] Ignoring invalid persisted update offset (${String(persistedOffsetRaw)}); starting without offset confirmation.`,
      );
    }

    const offsetPersistence = createTelegramUpdateOffsetPersistence({
      initialUpdateId: lastUpdateId,
      writeUpdateId: async (updateId) => {
        await writeTelegramUpdateOffset({
          accountId: account.accountId,
          updateId,
          botToken: token,
        });
      },
      onInvalidUpdateId: (updateId) => {
        log(`[telegram] Ignoring invalid update_id value: ${String(updateId)}`);
      },
      onRetry: ({ attempt, delayMs, error, updateId }) => {
        logError(
          `telegram: failed to persist update offset ${updateId}; retry ${attempt} in ${delayMs}ms: ${formatErrorMessage(error)}`,
        );
      },
      abortSignal: opts.abortSignal,
    });

    // Preserve sticky IPv4 fallback state across clean/conflict restarts.
    // Dirty polling cycles rebuild transport inside TelegramPollingSession.
    const createTelegramTransportForPolling = () =>
      resolveTelegramTransport(proxyFetch, {
        network: account.config.network,
      });
    const telegramTransport = createTelegramTransportForPolling();

    const pollingSession = new TelegramPollingSession({
      token,
      config: cfg,
      accountId: account.accountId,
      ownerAgentId,
      runtime: opts.runtime,
      buildContext: pluginChannelRuntime?.inbound.buildContext,
      // Forward the owning runtime's bound dispatcher into the turn plan; never invoked here.
      dispatchReplyFromConfig: pluginChannelRuntime?.reply?.dispatchReplyFromConfig,
      proxyFetch,
      botInfo: opts.botInfo,
      abortSignal: opts.abortSignal,
      getCommittedUpdateId: offsetPersistence.getCommittedUpdateId,
      persistUpdateId: offsetPersistence.persistUpdateId,
      log,
      telegramTransport,
      createTelegramTransport: createTelegramTransportForPolling,
      setStatus: opts.setStatus,
      ingress: {
        apiRoot: account.config.apiRoot,
        proxy: account.config.proxy,
        network: account.config.network,
      },
    });
    try {
      await pollingSession.runUntilAbort();
    } finally {
      await offsetPersistence.stop();
    }
  } finally {
    pollingLease.release();
  }
}
