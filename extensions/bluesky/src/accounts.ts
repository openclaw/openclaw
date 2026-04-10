import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  BlueskyAccountConfig,
  BlueskyChannelConfig,
  ResolvedBlueskyAccount,
} from "./types.js";

const DEFAULT_PDS_URL = "https://bsky.social";
const DEFAULT_ACCOUNT_ID = "default";

function getChannelConfig(cfg: Record<string, unknown>): BlueskyChannelConfig | undefined {
  const channels = cfg?.channels as Record<string, unknown> | undefined;
  return channels?.bluesky as BlueskyChannelConfig | undefined;
}

function mergeAccountConfig(
  base: BlueskyChannelConfig,
  override: BlueskyAccountConfig | undefined,
): BlueskyAccountConfig {
  return {
    enabled: override?.enabled ?? base.enabled,
    handle: override?.handle ?? base.handle,
    appPassword: override?.appPassword ?? base.appPassword,
    pdsUrl: override?.pdsUrl ?? base.pdsUrl,
  };
}

function resolveAppPassword(accountId: string, merged: BlueskyAccountConfig): string {
  const envPassword =
    accountId === DEFAULT_ACCOUNT_ID ? process.env.BLUESKY_APP_PASSWORD?.trim() : undefined;
  const configured = normalizeResolvedSecretInputString({
    value: merged.appPassword,
    path: `channels.bluesky.accounts.${accountId}.appPassword`,
  });
  return configured ?? envPassword ?? "";
}

function resolveHandle(accountId: string, merged: BlueskyAccountConfig): string {
  return (
    merged.handle?.trim() ||
    (accountId === DEFAULT_ACCOUNT_ID ? process.env.BLUESKY_HANDLE?.trim() : undefined) ||
    ""
  );
}

function resolvePdsUrl(accountId: string, merged: BlueskyAccountConfig): string {
  return (
    merged.pdsUrl?.trim() ||
    (accountId === DEFAULT_ACCOUNT_ID ? process.env.BLUESKY_PDS_URL?.trim() : undefined) ||
    DEFAULT_PDS_URL
  );
}

export function listBlueskyAccountIds(cfg: Record<string, unknown>): string[] {
  const channelCfg = getChannelConfig(cfg);
  if (!channelCfg) {
    return [];
  }
  const ids = new Set<string>();
  const hasBase =
    channelCfg.handle?.trim() ||
    process.env.BLUESKY_HANDLE ||
    channelCfg.appPassword ||
    process.env.BLUESKY_APP_PASSWORD;
  if (hasBase) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }
  for (const id of Object.keys(channelCfg.accounts ?? {})) {
    ids.add(id);
  }
  return Array.from(ids);
}

export function resolveBlueskyAccount(
  cfg: Record<string, unknown>,
  accountId?: string | null,
): ResolvedBlueskyAccount {
  const channelCfg = getChannelConfig(cfg) ?? {};
  const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
  const accountOverride = id === DEFAULT_ACCOUNT_ID ? undefined : (channelCfg.accounts?.[id] ?? {});
  const merged = mergeAccountConfig(channelCfg, accountOverride);

  const handle = resolveHandle(id, merged);
  const appPassword = resolveAppPassword(id, merged);
  const pdsUrl = resolvePdsUrl(id, merged);

  return {
    accountId: id,
    enabled: merged.enabled ?? true,
    configured: Boolean(handle && appPassword),
    handle,
    appPassword,
    pdsUrl,
  };
}

export function resolveDefaultBlueskyAccountId(cfg: Record<string, unknown>): string {
  const channelCfg = getChannelConfig(cfg);
  // If there are no top-level credentials, the named accounts are the real config.
  // Return the first named account so health/status picks a configured account as the default.
  const hasTopLevel =
    channelCfg?.handle?.trim() ||
    process.env.BLUESKY_HANDLE ||
    channelCfg?.appPassword ||
    process.env.BLUESKY_APP_PASSWORD;
  if (!hasTopLevel) {
    const firstAccountId = Object.keys(channelCfg?.accounts ?? {})[0];
    if (firstAccountId) {
      return firstAccountId;
    }
  }
  return DEFAULT_ACCOUNT_ID;
}
