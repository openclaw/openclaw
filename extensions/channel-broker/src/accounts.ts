import {
  hasConfiguredAccountValue,
  listCombinedAccountIds,
  resolveListedDefaultAccountId,
} from "openclaw/plugin-sdk/account-core";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveMergedAccountConfig } from "openclaw/plugin-sdk/account-resolution-runtime";
import { normalizeBrokerPlatformId } from "openclaw/plugin-sdk/channel-broker";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  ChannelBrokerConfig,
  ChannelBrokerProviderConfig,
  CoreConfig,
  ResolvedChannelBrokerAccount,
} from "./types.js";

export { DEFAULT_ACCOUNT_ID };

function getChannelBrokerConfig(cfg: CoreConfig): ChannelBrokerConfig | undefined {
  return cfg.channels?.["channel-broker"];
}

function resolveMergedBrokerProviderConfig(
  cfg: CoreConfig,
  accountId: string,
): ChannelBrokerProviderConfig {
  const channelConfig = getChannelBrokerConfig(cfg);
  const accounts = {
    ...(channelConfig?.providers ?? {}),
    ...(channelConfig?.accounts ?? {}),
  };
  return resolveMergedAccountConfig<ChannelBrokerProviderConfig>({
    channelConfig,
    accounts,
    accountId,
    omitKeys: ["accounts", "defaultAccount", "defaultProviderId", "providers"],
    normalizeAccountId,
  });
}

export function listChannelBrokerProviderIds(cfg: CoreConfig): string[] {
  const channelConfig = getChannelBrokerConfig(cfg);
  const providerIds = Object.keys(channelConfig?.providers ?? {});
  const accountIds = Object.keys(channelConfig?.accounts ?? {});
  return listCombinedAccountIds({
    configuredAccountIds: [...providerIds, ...accountIds].map(normalizeAccountId),
    implicitAccountId: hasConfiguredAccountValue(channelConfig?.baseUrl)
      ? DEFAULT_ACCOUNT_ID
      : undefined,
    fallbackAccountIdWhenEmpty: DEFAULT_ACCOUNT_ID,
  });
}

export function resolveDefaultChannelBrokerProviderId(cfg: CoreConfig): string {
  const channelConfig = getChannelBrokerConfig(cfg);
  const preferred = channelConfig?.defaultProviderId ?? channelConfig?.defaultAccount;
  return resolveListedDefaultAccountId({
    accountIds: listChannelBrokerProviderIds(cfg),
    configuredDefaultAccountId: preferred ? normalizeAccountId(preferred) : undefined,
  });
}

function normalizePlatformList(values: readonly string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => normalizeBrokerPlatformId(value))));
}

function normalizePlatformAliasMap(
  aliases: Record<string, string> | undefined,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [rawAlias, rawTarget] of Object.entries(aliases ?? {})) {
    normalized[normalizeBrokerPlatformId(rawAlias)] = normalizeBrokerPlatformId(rawTarget);
  }
  return normalized;
}

function normalizeCapabilities(
  capabilities: ChannelBrokerProviderConfig["capabilities"],
): NonNullable<ResolvedChannelBrokerAccount["capabilities"]> {
  const normalized: NonNullable<ResolvedChannelBrokerAccount["capabilities"]> = {};
  for (const [rawPlatform, value] of Object.entries(capabilities ?? {})) {
    const platform = normalizeBrokerPlatformId(rawPlatform);
    normalized[platform] = { ...value, platform };
  }
  return normalized;
}

export function resolveChannelBrokerAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedChannelBrokerAccount {
  const channelConfig = getChannelBrokerConfig(params.cfg);
  const accountId =
    normalizeOptionalString(params.accountId) ??
    normalizeOptionalString(channelConfig?.defaultProviderId) ??
    normalizeOptionalString(channelConfig?.defaultAccount) ??
    resolveDefaultChannelBrokerProviderId(params.cfg as never);
  const normalizedAccountId = normalizeAccountId(accountId);
  const merged = resolveMergedBrokerProviderConfig(params.cfg, normalizedAccountId);
  const baseEnabled = channelConfig?.enabled !== false;
  const enabled = baseEnabled && merged.enabled !== false;
  const baseUrl = normalizeOptionalString(merged.baseUrl) ?? null;
  const defaultPlatform = merged.defaultPlatform
    ? normalizeBrokerPlatformId(merged.defaultPlatform)
    : null;
  return {
    accountId: normalizeOptionalString(merged.accountId) ?? normalizedAccountId,
    providerId: normalizedAccountId,
    enabled,
    configured: Boolean(baseUrl),
    name: normalizeOptionalString(merged.name),
    baseUrl,
    outboundToken: normalizeOptionalString(merged.outboundToken) ?? null,
    signingSecret: normalizeOptionalString(merged.signingSecret) ?? null,
    platforms: normalizePlatformList(merged.platforms),
    platformAliases: normalizePlatformAliasMap(merged.platformAliases),
    defaultPlatform,
    defaultConversationType: merged.defaultConversationType ?? "channel",
    defaultTo: normalizeOptionalString(merged.defaultTo),
    allowFrom: merged.allowFrom ?? ["*"],
    capabilities: normalizeCapabilities(merged.capabilities),
    config: merged,
  };
}

export type { ResolvedChannelBrokerAccount };
