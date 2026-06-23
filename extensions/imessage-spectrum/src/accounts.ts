import {
  createAccountListHelpers,
  normalizeAccountId,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawConfig as SdkOpenClawConfig } from "openclaw/plugin-sdk/core";

const CHANNEL = "imessage-spectrum" as const;

const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers(CHANNEL, {
  implicitDefaultAccount: {
    channelKeys: ["account"],
  },
});

export const listSpectrumAccountIds = listAccountIds;
export const resolveDefaultSpectrumAccountId = resolveDefaultAccountId;

export type SpectrumAccountConfig = {
  enabled?: boolean;
  name?: string;
  projectId?: string;
  projectSecret?: string;
  webhookSecret?: string;
  webhookBaseUrl?: string;
  deliveryRetryCount?: number;
  deliveryRetryDelayMs?: number;
  deliveryQueueSize?: number;
  enableSessionContext?: boolean;
  sessionContext?: string;
  tunnelPort?: number;
  allowFrom?: string[];
  dmPolicy?: string;
  groupAllowFrom?: string[];
  groupPolicy?: string;
  catchup?: {
    enabled?: boolean;
    lookbackCount?: number;
    intervalMs?: number;
  };
};

export type ResolvedSpectrumAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  projectId: string;
  projectSecret: string;
  webhookSecret: string;
  webhookBaseUrl: string;
  deliveryRetryCount: number;
  deliveryRetryDelayMs: number;
  deliveryQueueSize: number;
  enableSessionContext: boolean;
  sessionContext?: string;
  tunnelPort: number;
  configured: boolean;
  webhookConfigured: boolean;
  config: SpectrumAccountConfig;
  catchupLookbackCount: number;
  catchupIntervalMs: number;
};

export function resolveSpectrumAccount(params: {
  cfg: SdkOpenClawConfig;
  accountId?: string | null;
}): ResolvedSpectrumAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultSpectrumAccountId(params.cfg),
  );
  const baseEnabled = (params.cfg.channels as Record<string, any>)?.[CHANNEL]?.enabled !== false;
  const merged = resolveMergedAccountConfig<SpectrumAccountConfig>({
    channelConfig: (params.cfg.channels as Record<string, any>)?.[CHANNEL] as
      | SpectrumAccountConfig
      | undefined,
    accounts: (params.cfg.channels as Record<string, any>)?.[CHANNEL]?.accounts as
      | Record<string, Partial<SpectrumAccountConfig>>
      | undefined,
    accountId,
  });
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const projectId = merged.projectId ?? "";
  const projectSecret = merged.projectSecret ?? "";
  const webhookSecret = merged.webhookSecret ?? "";
  const webhookBaseUrl = (merged.webhookBaseUrl ?? "").replace(/\/+$/, "");
  const deliveryRetryCount = Math.max(1, Math.min(10, merged.deliveryRetryCount ?? 3));
  const deliveryRetryDelayMs = Math.max(250, Math.min(60000, merged.deliveryRetryDelayMs ?? 1500));
  const deliveryQueueSize = Math.max(0, Math.min(500, merged.deliveryQueueSize ?? 100));
  const enableSessionContext = merged.enableSessionContext !== false;
  const tunnelPort = merged.tunnelPort ?? 18789;
  const catchupLookbackCount =
    typeof merged.catchup?.lookbackCount === "number" &&
    Number.isFinite(merged.catchup.lookbackCount)
      ? Math.max(1, Math.min(100, Math.floor(merged.catchup.lookbackCount)))
      : 25;
  const catchupIntervalMs =
    typeof merged.catchup?.intervalMs === "number" && Number.isFinite(merged.catchup.intervalMs)
      ? Math.max(5000, Math.min(300000, Math.floor(merged.catchup.intervalMs)))
      : 30000;
  const configured = Boolean(projectId && projectSecret);
  const webhookConfigured = Boolean(webhookSecret);
  return {
    accountId,
    enabled,
    name: merged.name,
    projectId,
    projectSecret,
    webhookSecret,
    webhookBaseUrl,
    deliveryRetryCount,
    deliveryRetryDelayMs,
    deliveryQueueSize,
    enableSessionContext,
    sessionContext: merged.sessionContext,
    tunnelPort,
    configured,
    webhookConfigured,
    config: merged,
    catchupLookbackCount,
    catchupIntervalMs,
  };
}

export function listEnabledSpectrumAccounts(cfg: SdkOpenClawConfig): ResolvedSpectrumAccount[] {
  return listSpectrumAccountIds(cfg)
    .map((accountId) => resolveSpectrumAccount({ cfg, accountId }))
    .filter((a) => a.enabled);
}
