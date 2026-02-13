import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type { ConvosConfig } from "./config-types.js";

export type CoreConfig = {
  channels?: {
    convos?: ConvosConfig;
  };
  [key: string]: unknown;
};

export type ResolvedConvosAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  configured: boolean;
  /** CLI-managed identity ID (stored in ~/.convos/identities/) */
  identityId?: string;
  /** XMTP environment */
  env: "production" | "dev";
  debug: boolean;
  /** Owner conversation ID for operator communication */
  ownerConversationId?: string;
  config: ConvosConfig;
};

export function listConvosAccountIds(_cfg: CoreConfig): string[] {
  return [DEFAULT_ACCOUNT_ID];
}

export function resolveDefaultConvosAccountId(cfg: CoreConfig): string {
  const ids = listConvosAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveConvosAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedConvosAccount {
  const accountId = normalizeAccountId(params.accountId);
  const base = params.cfg.channels?.convos ?? {};
  const enabled = base.enabled !== false;

  // Convos is "configured" if we have an owner conversation (identity + conversation established)
  const configured = Boolean(base.ownerConversationId);

  return {
    accountId,
    enabled,
    name: base.name?.trim() || undefined,
    configured,
    identityId: base.identityId,
    env: base.env ?? "production",
    debug: base.debug ?? false,
    ownerConversationId: base.ownerConversationId,
    config: base,
  };
}

export function listEnabledConvosAccounts(cfg: CoreConfig): ResolvedConvosAccount[] {
  return listConvosAccountIds(cfg)
    .map((accountId) => resolveConvosAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
