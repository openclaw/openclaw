import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { z } from "zod";
import type { DchatAccountConfig, ResolvedDchatAccount } from "./types.js";

type CoreConfig = OpenClawConfig & {
  channels?: {
    dchat?: DchatAccountConfig & {
      accounts?: Record<string, DchatAccountConfig>;
      defaultAccount?: string;
    };
  };
};

export type { CoreConfig };

const DEFAULT_ACCOUNT_ID = "default";

/* ── Zod config schema (powers web UI form via buildChannelConfigSchema) ── */

const dchatAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  seed: z.string().optional(),
  keystoreJson: z.string().optional(),
  keystorePassword: z.string().optional(),
  numSubClients: z.number().optional(),
  ipfsGateway: z.string().optional(),
  dm: z
    .object({
      policy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
      allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    })
    .optional(),
});

export const DchatConfigSchema = dchatAccountSchema.extend({
  accounts: z.record(z.string(), dchatAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
});

/* ── Config helpers ── */

export function listDchatAccountIds(cfg: CoreConfig): string[] {
  const dchatConfig = cfg.channels?.dchat;
  if (!dchatConfig) return [];

  const ids: string[] = [];

  // Top-level config counts as the default account
  if (dchatConfig.seed || dchatConfig.keystoreJson) {
    ids.push(DEFAULT_ACCOUNT_ID);
  }

  // Named accounts
  if (dchatConfig.accounts) {
    for (const id of Object.keys(dchatConfig.accounts)) {
      if (!ids.includes(id)) {
        ids.push(id);
      }
    }
  }

  if (ids.length === 0 && dchatConfig.enabled !== false) {
    ids.push(DEFAULT_ACCOUNT_ID);
  }

  return ids;
}

export function resolveDefaultDchatAccountId(cfg: CoreConfig): string {
  const dchatConfig = cfg.channels?.dchat;
  if (dchatConfig?.defaultAccount) return dchatConfig.defaultAccount;
  // If top-level seed exists, treat as the default account
  if (dchatConfig?.seed?.trim()) return DEFAULT_ACCOUNT_ID;
  // Otherwise pick the first named account
  const named = dchatConfig?.accounts ? Object.keys(dchatConfig.accounts) : [];
  return named[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveDchatAccountConfig(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): DchatAccountConfig {
  const { cfg, accountId } = params;
  const dchatConfig = cfg.channels?.dchat;
  if (!dchatConfig) return { enabled: false };

  if (accountId && dchatConfig.accounts?.[accountId]) {
    // Named account: merge channel-level fields (e.g. dm policy) as defaults
    const acct = dchatConfig.accounts[accountId];
    return {
      ...dchatConfig,
      ...acct,
      dm: { ...dchatConfig.dm, ...acct.dm },
    };
  }

  // Top-level config (default account without explicit accounts.default entry)
  return dchatConfig;
}

export function resolveDchatAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedDchatAccount {
  const { cfg, accountId: rawAccountId } = params;
  const accountId = rawAccountId || DEFAULT_ACCOUNT_ID;
  const accountConfig = resolveDchatAccountConfig({ cfg, accountId });

  const hasSeed = Boolean(accountConfig.seed?.trim());
  const hasKeystore = Boolean(accountConfig.keystoreJson?.trim());

  const baseEnabled = cfg.channels?.dchat?.enabled !== false;
  return {
    accountId,
    name: accountConfig.name || accountId,
    enabled: baseEnabled && accountConfig.enabled !== false,
    configured: hasSeed,
    seed: accountConfig.seed?.trim(),
    numSubClients: accountConfig.numSubClients ?? 4,
    ipfsGateway: accountConfig.ipfsGateway ?? "64.225.88.71:80",
    config: accountConfig,
  };
}
