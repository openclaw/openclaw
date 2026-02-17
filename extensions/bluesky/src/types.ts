import type { OpenClawConfig } from "openclaw/plugin-sdk";

export interface BlueskyAccountConfig {
  enabled?: boolean;
  name?: string;
  identifier?: string;
  appPassword?: string;
  service?: string;
  pollIntervalMs?: number;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: Array<string | number>;
}

export interface ResolvedBlueskyAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  identifier: string;
  service: string;
  config: BlueskyAccountConfig;
}

const DEFAULT_ACCOUNT_ID = "default";
const DEFAULT_SERVICE = "https://bsky.social";
const DEFAULT_POLL_INTERVAL_MS = 5000;

/**
 * List all configured Bluesky account IDs
 */
export function listBlueskyAccountIds(cfg: OpenClawConfig): string[] {
  const bskyCfg = (cfg.channels as Record<string, unknown> | undefined)?.bluesky as
    | BlueskyAccountConfig
    | undefined;

  if (bskyCfg?.identifier && bskyCfg?.appPassword) {
    return [DEFAULT_ACCOUNT_ID];
  }

  return [];
}

/**
 * Get the default account ID
 */
export function resolveDefaultBlueskyAccountId(cfg: OpenClawConfig): string {
  const ids = listBlueskyAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

/**
 * Resolve a Bluesky account from config
 */
export function resolveBlueskyAccount(opts: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedBlueskyAccount {
  const accountId = opts.accountId ?? DEFAULT_ACCOUNT_ID;
  const bskyCfg = (opts.cfg.channels as Record<string, unknown> | undefined)?.bluesky as
    | BlueskyAccountConfig
    | undefined;

  const baseEnabled = bskyCfg?.enabled !== false;
  const identifier = bskyCfg?.identifier?.trim() ?? "";
  const appPassword = bskyCfg?.appPassword?.trim() ?? "";
  const configured = Boolean(identifier && appPassword);
  const service = bskyCfg?.service?.trim() || DEFAULT_SERVICE;

  return {
    accountId,
    name: bskyCfg?.name?.trim() || undefined,
    enabled: baseEnabled,
    configured,
    identifier,
    service,
    config: {
      enabled: bskyCfg?.enabled,
      name: bskyCfg?.name,
      identifier: bskyCfg?.identifier,
      appPassword: bskyCfg?.appPassword,
      service: bskyCfg?.service,
      pollIntervalMs: bskyCfg?.pollIntervalMs,
      dmPolicy: bskyCfg?.dmPolicy,
      allowFrom: bskyCfg?.allowFrom,
    },
  };
}

export { DEFAULT_ACCOUNT_ID, DEFAULT_SERVICE, DEFAULT_POLL_INTERVAL_MS };
