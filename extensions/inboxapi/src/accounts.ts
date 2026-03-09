/**
 * Account resolution: reads config from channels.inboxapi,
 * merges per-account overrides, falls back to environment variables.
 */

import type { InboxApiChannelConfig, ResolvedInboxApiAccount } from "./types.js";

const DEFAULT_MCP_ENDPOINT = "https://mcp.inboxapi.ai/mcp";
const DEFAULT_CREDENTIALS_PATH = "~/.local/inboxapi/credentials.json";
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_POLL_BATCH_SIZE = 20;
const DEFAULT_TEXT_CHUNK_LIMIT = 50_000;

/** Extract the channel config from the full OpenClaw config object. */
function getChannelConfig(cfg: any): InboxApiChannelConfig | undefined {
  return cfg?.channels?.inboxapi;
}

/** Parse allowFrom from string or array to string[]. */
function parseAllowFrom(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean).map((s) => s.toLowerCase().trim());
  return raw
    .split(",")
    .map((s) => s.toLowerCase().trim())
    .filter(Boolean);
}

/**
 * List all configured account IDs for this channel.
 * Always includes "default" when the channel section exists, because
 * resolveAccount falls back to the default credentials file path
 * (~/.local/inboxapi/credentials.json) even without explicit config fields.
 * Also includes any named accounts under channels.inboxapi.accounts.
 */
export function listAccountIds(cfg: any): string[] {
  const channelCfg = getChannelConfig(cfg);
  if (!channelCfg) return [];

  const ids = new Set<string>(["default"]);

  // Named accounts
  if (channelCfg.accounts) {
    for (const id of Object.keys(channelCfg.accounts)) {
      ids.add(id);
    }
  }

  return Array.from(ids);
}

/**
 * Resolve a specific account by ID with full defaults applied.
 * Falls back to env vars for the "default" account.
 */
export function resolveAccount(cfg: any, accountId?: string | null): ResolvedInboxApiAccount {
  const channelCfg = getChannelConfig(cfg) ?? {};
  const id = accountId || "default";

  // Account-specific overrides (if named account exists)
  const accountOverride = channelCfg.accounts?.[id] ?? {};

  // Env var fallbacks
  const envAccessToken = process.env.INBOXAPI_ACCESS_TOKEN ?? "";
  const envDomain = process.env.INBOXAPI_DOMAIN ?? "";
  const envFromName = process.env.INBOXAPI_FROM_NAME ?? "";

  // Merge: account override > base channel config > env var > default
  return {
    accountId: id,
    enabled: accountOverride.enabled ?? channelCfg.enabled ?? true,
    mcpEndpoint: accountOverride.mcpEndpoint ?? channelCfg.mcpEndpoint ?? DEFAULT_MCP_ENDPOINT,
    credentialsPath:
      accountOverride.credentialsPath ?? channelCfg.credentialsPath ?? DEFAULT_CREDENTIALS_PATH,
    accessToken: accountOverride.accessToken ?? channelCfg.accessToken ?? envAccessToken,
    domain: accountOverride.domain ?? channelCfg.domain ?? envDomain,
    fromName: accountOverride.fromName ?? channelCfg.fromName ?? envFromName,
    pollIntervalMs:
      accountOverride.pollIntervalMs ?? channelCfg.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    pollBatchSize:
      accountOverride.pollBatchSize ?? channelCfg.pollBatchSize ?? DEFAULT_POLL_BATCH_SIZE,
    dmPolicy: accountOverride.dmPolicy ?? channelCfg.dmPolicy ?? "allowlist",
    allowFrom: parseAllowFrom(accountOverride.allowFrom ?? channelCfg.allowFrom),
    textChunkLimit:
      accountOverride.textChunkLimit ?? channelCfg.textChunkLimit ?? DEFAULT_TEXT_CHUNK_LIMIT,
  };
}
