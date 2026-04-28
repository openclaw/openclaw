import {
  createAccountActionGate,
  createAccountListHelpers,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-helpers";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveAccountEntry } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
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
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultDiscordAccountId(params.cfg),
  );
  return createAccountActionGate({
    baseActions: params.cfg.channels?.discord?.actions,
    accountActions: resolveDiscordAccountConfig(params.cfg, accountId)?.actions,
  });
}

export function resolveDiscordAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedDiscordAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultDiscordAccountId(params.cfg),
  );
  const baseEnabled = params.cfg.channels?.discord?.enabled !== false;
  const merged = mergeDiscordAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const tokenResolution = resolveDiscordToken(params.cfg, { accountId });
  return {
    accountId,
    enabled,
    name: normalizeOptionalString(merged.name),
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

export function deduplicateDiscordAccountsByToken(
  accounts: ResolvedDiscordAccount[],
): ResolvedDiscordAccount[] {
  const tokenGroups = new Map<string, ResolvedDiscordAccount[]>();
  const result: ResolvedDiscordAccount[] = [];

  for (const account of accounts) {
    const token = account.token.trim();
    if (!token) {
      result.push(account);
      continue;
    }
    let group = tokenGroups.get(token);
    if (!group) {
      group = [];
      tokenGroups.set(token, group);
    }
    group.push(account);
  }

  for (const [, group] of tokenGroups) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    const configAccounts = group.filter((a) => a.tokenSource === "config");
    const kept = configAccounts.length > 0 ? configAccounts[0] : group[0];
    const dropped = group.filter((a) => a !== kept);
    console.warn(
      `[discord] duplicate bot token detected: keeping account "${kept.accountId}" (source: ${kept.tokenSource}), dropping ${dropped.map((a) => `"${a.accountId}"`).join(", ")}`,
    );
    result.push(kept);
  }

  return result;
}

export function listEnabledDiscordAccounts(cfg: OpenClawConfig): ResolvedDiscordAccount[] {
  const enabled = listDiscordAccountIds(cfg)
    .map((accountId) => resolveDiscordAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
  return deduplicateDiscordAccountsByToken(enabled);
}
