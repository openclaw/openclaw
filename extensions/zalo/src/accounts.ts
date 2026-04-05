import {
  createAccountListHelpers,
  resolveMergedAccountConfig,
} from "mullusi/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "mullusi/plugin-sdk/account-id";
import type { MullusiConfig } from "./runtime-api.js";
import { resolveZaloToken } from "./token.js";
import type { ResolvedZaloAccount, ZaloAccountConfig, ZaloConfig } from "./types.js";

export type { ResolvedZaloAccount };

const { listAccountIds: listZaloAccountIds, resolveDefaultAccountId: resolveDefaultZaloAccountId } =
  createAccountListHelpers("zalo");
export { listZaloAccountIds, resolveDefaultZaloAccountId };

function mergeZaloAccountConfig(cfg: MullusiConfig, accountId: string): ZaloAccountConfig {
  return resolveMergedAccountConfig<ZaloAccountConfig>({
    channelConfig: cfg.channels?.zalo as ZaloAccountConfig | undefined,
    accounts: (cfg.channels?.zalo as ZaloConfig | undefined)?.accounts as
      | Record<string, Partial<ZaloAccountConfig>>
      | undefined,
    accountId,
    omitKeys: ["defaultAccount"],
  });
}

export function resolveZaloAccount(params: {
  cfg: MullusiConfig;
  accountId?: string | null;
  allowUnresolvedSecretRef?: boolean;
}): ResolvedZaloAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? (params.cfg.channels?.zalo as ZaloConfig | undefined)?.defaultAccount,
  );
  const baseEnabled = (params.cfg.channels?.zalo as ZaloConfig | undefined)?.enabled !== false;
  const merged = mergeZaloAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const tokenResolution = resolveZaloToken(
    params.cfg.channels?.zalo as ZaloConfig | undefined,
    accountId,
    { allowUnresolvedSecretRef: params.allowUnresolvedSecretRef },
  );

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    token: tokenResolution.token,
    tokenSource: tokenResolution.source,
    config: merged,
  };
}

export function listEnabledZaloAccounts(cfg: MullusiConfig): ResolvedZaloAccount[] {
  return listZaloAccountIds(cfg)
    .map((accountId) => resolveZaloAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
