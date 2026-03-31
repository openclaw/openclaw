import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "openclaw/plugin-sdk/account-id";

export interface UtopiaAccountConfig {
  enabled?: boolean;
  name?: string;
  defaultAccount?: string;
  host?: string;
  port?: number;
  apiToken?: string;
  wsPort?: number;
  useSsl?: boolean;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: Array<string | number>;
}

export interface ResolvedUtopiaAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  host: string;
  port: number;
  apiToken: string;
  wsPort: number;
  useSsl: boolean;
  publicKey: string;
  config: UtopiaAccountConfig;
}

function resolveConfiguredDefaultUtopiaAccountId(cfg: OpenClawConfig): string | undefined {
  const utopiaCfg = (cfg.channels as Record<string, unknown> | undefined)?.utopia as
    | UtopiaAccountConfig
    | undefined;
  return normalizeOptionalAccountId(utopiaCfg?.defaultAccount);
}

/**
 * List all configured Utopia account IDs
 */
export function listUtopiaAccountIds(cfg: OpenClawConfig): string[] {
  const utopiaCfg = (cfg.channels as Record<string, unknown> | undefined)?.utopia as
    | UtopiaAccountConfig
    | undefined;

  // If apiToken is configured at top level, we have a default account
  if (utopiaCfg?.apiToken) {
    return [resolveConfiguredDefaultUtopiaAccountId(cfg) ?? DEFAULT_ACCOUNT_ID];
  }

  return [];
}

/**
 * Get the default account ID
 */
export function resolveDefaultUtopiaAccountId(cfg: OpenClawConfig): string {
  const preferred = resolveConfiguredDefaultUtopiaAccountId(cfg);
  if (preferred) {
    return preferred;
  }
  const ids = listUtopiaAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

/**
 * Resolve a Utopia account from config
 */
export function resolveUtopiaAccount(opts: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedUtopiaAccount {
  const accountId = normalizeAccountId(opts.accountId ?? resolveDefaultUtopiaAccountId(opts.cfg));
  const utopiaCfg = (opts.cfg.channels as Record<string, unknown> | undefined)?.utopia as
    | UtopiaAccountConfig
    | undefined;

  const baseEnabled = utopiaCfg?.enabled !== false;
  const apiToken = utopiaCfg?.apiToken ?? "";
  const configured = Boolean(apiToken.trim());

  return {
    accountId,
    name: utopiaCfg?.name?.trim() || undefined,
    enabled: baseEnabled,
    configured,
    host: utopiaCfg?.host ?? "127.0.0.1",
    port: utopiaCfg?.port ?? 20000,
    apiToken,
    wsPort: utopiaCfg?.wsPort ?? 25000,
    useSsl: utopiaCfg?.useSsl ?? false,
    publicKey: "", // Resolved at runtime via getOwnContact
    config: {
      enabled: utopiaCfg?.enabled,
      name: utopiaCfg?.name,
      host: utopiaCfg?.host,
      port: utopiaCfg?.port,
      apiToken: utopiaCfg?.apiToken,
      wsPort: utopiaCfg?.wsPort,
      useSsl: utopiaCfg?.useSsl,
      dmPolicy: utopiaCfg?.dmPolicy,
      allowFrom: utopiaCfg?.allowFrom,
    },
  };
}
