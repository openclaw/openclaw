import { DEFAULT_ACCOUNT_ID, normalizePluginHttpPath } from "openclaw/plugin-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

import type {
  DailyflowsAccountConfig,
  DailyflowsChannelConfig,
  ResolvedDailyflowsAccount,
} from "./types.js";

export const DEFAULT_WEBHOOK_PATH = "/dailyflows/webhook";

function getDailyflowsConfig(cfg: OpenClawConfig): DailyflowsChannelConfig {
  return (cfg.channels?.dailyflows ?? {}) as DailyflowsChannelConfig;
}

export function listDailyflowsAccountIds(cfg: OpenClawConfig): string[] {
  const config = getDailyflowsConfig(cfg);
  const accounts = config.accounts ?? {};
  const ids = Object.keys(accounts);
  return ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
}

export function resolveDailyflowsAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedDailyflowsAccount {
  const config = getDailyflowsConfig(cfg);
  const resolvedId = accountId ?? DEFAULT_ACCOUNT_ID;
  const account: DailyflowsAccountConfig = config.accounts?.[resolvedId] ?? {};
  const enabled = account.enabled ?? config.enabled ?? true;
  return {
    accountId: resolvedId,
    name: account.name,
    enabled,
    webhookSecret: account.webhookSecret ?? config.webhookSecret,
    outboundUrl: account.outboundUrl,
    outboundToken: account.outboundToken,
    config,
  };
}

export function resolveDailyflowsWebhookPath(cfg: OpenClawConfig): string {
  const config = getDailyflowsConfig(cfg);
  const resolved = normalizePluginHttpPath(config.webhookPath, DEFAULT_WEBHOOK_PATH);
  return resolved ?? DEFAULT_WEBHOOK_PATH;
}

function normalizeAccountIdForEnv(accountId: string): string {
  return accountId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

export function resolveDailyflowsWebhookSecret(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string | null {
  const { cfg, accountId } = params;
  const resolvedId = accountId ?? DEFAULT_ACCOUNT_ID;
  const envKey = `DAILYFLOWS_WEBHOOK_SECRET_${normalizeAccountIdForEnv(resolvedId)}`;
  const envSpecific = process.env[envKey]?.trim();
  if (envSpecific) {
    return envSpecific;
  }
  const envGlobal = process.env.DAILYFLOWS_WEBHOOK_SECRET?.trim();
  if (envGlobal) {
    return envGlobal;
  }
  return resolveDailyflowsAccount(cfg, resolvedId).webhookSecret?.trim() ?? null;
}
