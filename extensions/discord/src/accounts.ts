import {
  createAccountActionGate,
  createAccountListHelpers,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-helpers";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  resolveAccountEntry,
  resolveOwningAgentIdForChannelAccount,
} from "openclaw/plugin-sdk/routing";
import { parseApplicationIdFromToken } from "./probe.js";
import type { DiscordAccountConfig, DiscordActionConfig, OpenClawConfig } from "./runtime-api.js";
import { resolveDiscordToken } from "./token.js";

export type ResolvedDiscordAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  token: string;
  tokenSource: "env" | "config" | "none";
  config: DiscordAccountConfig;
};

const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("discord");
export const listDiscordAccountIds = listAccountIds;
export const resolveDefaultDiscordAccountId = resolveDefaultAccountId;

export function resolveDiscordAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): DiscordAccountConfig | undefined {
  return resolveAccountEntry(cfg.channels?.discord?.accounts, accountId);
}

export function mergeDiscordAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): DiscordAccountConfig {
  return resolveMergedAccountConfig<DiscordAccountConfig>({
    channelConfig: cfg.channels?.discord as DiscordAccountConfig | undefined,
    accounts: cfg.channels?.discord?.accounts as
      | Record<string, Partial<DiscordAccountConfig>>
      | undefined,
    accountId,
  });
}

export function createDiscordActionGate(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): (key: keyof DiscordActionConfig, defaultValue?: boolean) => boolean {
  const accountId = normalizeAccountId(params.accountId);
  return createAccountActionGate({
    baseActions: params.cfg.channels?.discord?.actions,
    accountActions: resolveDiscordAccountConfig(params.cfg, accountId)?.actions,
  });
}

export function resolveDiscordAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedDiscordAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.discord?.enabled !== false;
  const merged = mergeDiscordAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const tokenResolution = resolveDiscordToken(params.cfg, { accountId });
  return {
    accountId,
    enabled,
    name: merged.name?.trim() || undefined,
    token: tokenResolution.token,
    tokenSource: tokenResolution.source,
    config: merged,
  };
}

export function resolveDiscordMaxLinesPerMessage(params: {
  cfg: OpenClawConfig;
  discordConfig?: DiscordAccountConfig | null;
  accountId?: string | null;
}): number | undefined {
  if (typeof params.discordConfig?.maxLinesPerMessage === "number") {
    return params.discordConfig.maxLinesPerMessage;
  }
  return resolveDiscordAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  }).config.maxLinesPerMessage;
}

export function listEnabledDiscordAccounts(cfg: OpenClawConfig): ResolvedDiscordAccount[] {
  return listDiscordAccountIds(cfg)
    .map((accountId) => resolveDiscordAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}

function normalizeDiscordBotUserId(botUserId?: string | null): string | undefined {
  const normalizedBotUserId = botUserId?.trim();
  return normalizedBotUserId || undefined;
}

export function resolveConfiguredDiscordBotAgentIdsByBotUserId(params: {
  cfg: OpenClawConfig;
  currentAccountId: string;
  currentBotUserId?: string | null;
}): ReadonlyMap<string, string> {
  const identityAgentIds = new Map<string, string>();
  const ambiguousBotUserIds = new Set<string>();
  for (const account of listEnabledDiscordAccounts(params.cfg)) {
    const senderAgentId = resolveOwningAgentIdForChannelAccount(
      params.cfg,
      "discord",
      account.accountId,
    );
    if (!senderAgentId) {
      continue;
    }
    const botUserId = normalizeDiscordBotUserId(
      account.accountId === params.currentAccountId
        ? params.currentBotUserId
        : parseApplicationIdFromToken(account.token),
    );
    if (!botUserId || ambiguousBotUserIds.has(botUserId)) {
      continue;
    }
    const existingAgentId = identityAgentIds.get(botUserId);
    if (!existingAgentId) {
      identityAgentIds.set(botUserId, senderAgentId);
      continue;
    }
    if (existingAgentId !== senderAgentId) {
      identityAgentIds.delete(botUserId);
      ambiguousBotUserIds.add(botUserId);
    }
  }
  return identityAgentIds;
}
