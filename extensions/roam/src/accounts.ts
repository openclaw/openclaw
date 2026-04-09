import { tryReadSecretFileSync } from "openclaw/plugin-sdk/infra-runtime";
import {
  createAccountListHelpers,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  resolveAccountWithDefaultFallback,
} from "../runtime-api.js";
import { normalizeResolvedSecretInputString } from "./secret-input.js";
import type { CoreConfig, RoamAccountConfig, RoamBotIdentity } from "./types.js";

export type ResolvedRoamAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  apiKey: string;
  apiKeySource: "env" | "secretFile" | "config" | "none";
  config: RoamAccountConfig;
  /** Bot persona identity, populated at monitor startup via token.info. */
  botIdentity?: RoamBotIdentity;
};

const {
  listAccountIds: listRoamAccountIdsInternal,
  resolveDefaultAccountId: resolveDefaultRoamAccountId,
} = createAccountListHelpers("roam", {
  normalizeAccountId,
});
export { resolveDefaultRoamAccountId };

export function listRoamAccountIds(cfg: CoreConfig): string[] {
  return listRoamAccountIdsInternal(cfg);
}

function resolveAccountConfig(cfg: CoreConfig, accountId: string): RoamAccountConfig | undefined {
  const accounts = cfg.channels?.roam?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  const direct = accounts[accountId] as RoamAccountConfig | undefined;
  if (direct) {
    return direct;
  }
  const normalized = normalizeAccountId(accountId);
  const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
  return matchKey ? (accounts[matchKey] as RoamAccountConfig | undefined) : undefined;
}

function mergeRoamAccountConfig(cfg: CoreConfig, accountId: string): RoamAccountConfig {
  const {
    accounts: _ignored,
    defaultAccount: _ignoredDefaultAccount,
    ...base
  } = (cfg.channels?.roam ?? {}) as RoamAccountConfig & {
    accounts?: unknown;
    defaultAccount?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

function resolveRoamApiKey(
  cfg: CoreConfig,
  opts: { accountId?: string },
): { apiKey: string; source: ResolvedRoamAccount["apiKeySource"] } {
  const merged = mergeRoamAccountConfig(cfg, opts.accountId ?? DEFAULT_ACCOUNT_ID);

  const envKey = process.env.ROAM_API_KEY?.trim();
  if (envKey && (!opts.accountId || opts.accountId === DEFAULT_ACCOUNT_ID)) {
    return { apiKey: envKey, source: "env" };
  }

  if (merged.apiKeyFile) {
    const fileKey = tryReadSecretFileSync(merged.apiKeyFile, "Roam API key file", {
      rejectSymlink: true,
    });
    if (fileKey) {
      return { apiKey: fileKey, source: "secretFile" };
    }
  }

  const inlineKey = normalizeResolvedSecretInputString({
    value: merged.apiKey,
    path: `channels.roam.accounts.${opts.accountId ?? DEFAULT_ACCOUNT_ID}.apiKey`,
  });
  if (inlineKey) {
    return { apiKey: inlineKey, source: "config" };
  }

  return { apiKey: "", source: "none" };
}

export function resolveRoamAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedRoamAccount {
  const baseEnabled = params.cfg.channels?.roam?.enabled !== false;

  const resolve = (accountId: string) => {
    const merged = mergeRoamAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;
    const keyResolution = resolveRoamApiKey(params.cfg, { accountId });

    return {
      accountId,
      enabled,
      name: merged.name?.trim() || undefined,
      apiKey: keyResolution.apiKey,
      apiKeySource: keyResolution.source,
      config: merged,
    } satisfies ResolvedRoamAccount;
  };

  return resolveAccountWithDefaultFallback({
    accountId: params.accountId,
    normalizeAccountId,
    resolvePrimary: resolve,
    hasCredential: (account) => account.apiKeySource !== "none",
    resolveDefaultAccountId: () => resolveDefaultRoamAccountId(params.cfg),
  });
}

export function listEnabledRoamAccounts(cfg: CoreConfig): ResolvedRoamAccount[] {
  return listRoamAccountIds(cfg)
    .map((accountId) => resolveRoamAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
