import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { EmailAccountConfig, ResolvedEmailAccount } from "./types.js";

/**
 * List all configured email account IDs.
 */
export function listEmailAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = (cfg.channels as Record<string, unknown> | undefined)?.email as
    | { accounts?: Record<string, unknown> }
    | undefined;
  if (!accounts?.accounts) {
    return [];
  }
  return Object.keys(accounts.accounts);
}

/**
 * Resolve the default email account ID.
 */
export function resolveDefaultEmailAccountId(cfg: OpenClawConfig): string {
  const ids = listEmailAccountIds(cfg);
  if (ids.length === 0) {
    return DEFAULT_ACCOUNT_ID;
  }
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0];
}

/**
 * Resolve a full email account config from the OpenClaw config.
 */
export function resolveEmailAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedEmailAccount {
  const { cfg, accountId } = params;
  const resolvedId = accountId?.trim() || resolveDefaultEmailAccountId(cfg);

  const emailSection = (cfg.channels as Record<string, unknown> | undefined)?.email as
    | { accounts?: Record<string, EmailAccountConfig> }
    | undefined;

  const raw = emailSection?.accounts?.[resolvedId] ?? {};

  return {
    accountId: resolvedId,
    name: raw.name ?? "Email",
    enabled: raw.enabled !== false,
    address: raw.address ?? "",
    outboundUrl: raw.outboundUrl ?? "",
    outboundToken: raw.outboundToken ?? "",
    dmPolicy: raw.dmPolicy ?? "open",
    allowFrom: raw.allowFrom ?? [],
  };
}
