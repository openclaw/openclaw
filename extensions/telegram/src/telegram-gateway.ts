import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { clearAccountEntryFields } from "openclaw/plugin-sdk/core";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { resolveTelegramAccount } from "./accounts.js";
import type { ResolvedTelegramAccount } from "./accounts.js";
import { getTelegramRuntime } from "./runtime.js";
import { findTelegramTokenOwnerAccountId, formatDuplicateTelegramTokenReason } from "./shared.js";

let telegramMonitorModulePromise: Promise<typeof import("./monitor.js")> | null = null;
let telegramProbeModulePromise: Promise<typeof import("./probe.js")> | null = null;

async function loadTelegramMonitorModule() {
  telegramMonitorModulePromise ??= import("./monitor.js");
  return await telegramMonitorModulePromise;
}

async function loadTelegramProbeModule() {
  telegramProbeModulePromise ??= import("./probe.js");
  return await telegramProbeModulePromise;
}

function getOptionalTelegramRuntime() {
  try {
    return getTelegramRuntime();
  } catch {
    return null;
  }
}

async function resolveTelegramProbe() {
  return (
    getOptionalTelegramRuntime()?.channel?.telegram?.probeTelegram ??
    (await loadTelegramProbeModule()).probeTelegram
  );
}

async function resolveTelegramMonitor() {
  return (
    getOptionalTelegramRuntime()?.channel?.telegram?.monitorTelegramProvider ??
    (await loadTelegramMonitorModule()).monitorTelegramProvider
  );
}

export const telegramGateway = {
  startAccount: async (ctx: {
    account: ResolvedTelegramAccount;
    cfg: OpenClawConfig;
    runtime: RuntimeEnv;
    abortSignal: AbortSignal;
    log?: {
      info?: (message: string) => void;
      debug?: (message: string) => void;
      error?: (message: string) => void;
    };
  }) => {
    const account = ctx.account;
    const ownerAccountId = findTelegramTokenOwnerAccountId({
      cfg: ctx.cfg,
      accountId: account.accountId,
    });
    if (ownerAccountId) {
      const reason = formatDuplicateTelegramTokenReason({
        accountId: account.accountId,
        ownerAccountId,
      });
      ctx.log?.error?.(`[${account.accountId}] ${reason}`);
      throw new Error(reason);
    }
    const token = (account.token ?? "").trim();
    let telegramBotLabel = "";
    try {
      const probe = await (
        await resolveTelegramProbe()
      )(token, 2500, {
        accountId: account.accountId,
        proxyUrl: account.config.proxy,
        network: account.config.network,
        apiRoot: account.config.apiRoot,
      });
      const username = probe.ok ? probe.bot?.username?.trim() : null;
      if (username) {
        telegramBotLabel = ` (@${username})`;
      }
    } catch (err) {
      if (getTelegramRuntime().logging.shouldLogVerbose()) {
        ctx.log?.debug?.(`[${account.accountId}] bot probe failed: ${String(err)}`);
      }
    }
    ctx.log?.info?.(`[${account.accountId}] starting provider${telegramBotLabel}`);
    return (await resolveTelegramMonitor())({
      token,
      accountId: account.accountId,
      config: ctx.cfg,
      runtime: ctx.runtime,
      abortSignal: ctx.abortSignal,
      useWebhook: Boolean(account.config.webhookUrl),
      webhookUrl: account.config.webhookUrl,
      webhookSecret: account.config.webhookSecret,
      webhookPath: account.config.webhookPath,
      webhookHost: account.config.webhookHost,
      webhookPort: account.config.webhookPort,
      webhookCertPath: account.config.webhookCertPath,
    });
  },
  logoutAccount: async ({ accountId, cfg }: { accountId: string; cfg: OpenClawConfig }) => {
    const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
    const nextCfg = { ...cfg } as OpenClawConfig;
    const nextTelegram = cfg.channels?.telegram ? { ...cfg.channels.telegram } : undefined;
    let cleared = false;
    let changed = false;
    if (nextTelegram) {
      if (accountId === DEFAULT_ACCOUNT_ID && nextTelegram.botToken) {
        delete nextTelegram.botToken;
        cleared = true;
        changed = true;
      }
      const accountCleanup = clearAccountEntryFields({
        accounts: nextTelegram.accounts,
        accountId,
        fields: ["botToken"],
      });
      if (accountCleanup.changed) {
        changed = true;
        if (accountCleanup.cleared) {
          cleared = true;
        }
        if (accountCleanup.nextAccounts) {
          nextTelegram.accounts = accountCleanup.nextAccounts;
        } else {
          delete nextTelegram.accounts;
        }
      }
    }
    if (changed) {
      if (nextTelegram && Object.keys(nextTelegram).length > 0) {
        nextCfg.channels = { ...nextCfg.channels, telegram: nextTelegram };
      } else {
        const nextChannels = { ...nextCfg.channels };
        delete nextChannels.telegram;
        if (Object.keys(nextChannels).length > 0) {
          nextCfg.channels = nextChannels;
        } else {
          delete nextCfg.channels;
        }
      }
    }
    const resolved = resolveTelegramAccount({
      cfg: changed ? nextCfg : cfg,
      accountId,
    });
    const loggedOut = resolved.tokenSource === "none";
    if (changed) {
      await getTelegramRuntime().config.writeConfigFile(nextCfg);
    }
    return { cleared, envToken: Boolean(envToken), loggedOut };
  },
};
