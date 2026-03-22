import { createAccountListHelpers, mergeAccountConfig } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveAccountEntry } from "openclaw/plugin-sdk/routing";
import type { OpenClawConfig } from "./runtime-api.js";
import { resolveZaloToken } from "./token.js";
import type { ResolvedZaloAccount, ZaloAccountConfig, ZaloConfig } from "./types.js";

export type { ResolvedZaloAccount };

const { listAccountIds: listZaloAccountIds, resolveDefaultAccountId: resolveDefaultZaloAccountId } =
  createAccountListHelpers("zalo");
export { listZaloAccountIds, resolveDefaultZaloAccountId };

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): ZaloAccountConfig | undefined {
  return resolveAccountEntry(
    (cfg.channels?.zalo as ZaloConfig | undefined)?.accounts as
      | Record<string, ZaloAccountConfig>
      | undefined,
    accountId,
  );
}

function mergeZaloAccountConfig(cfg: OpenClawConfig, accountId: string): ZaloAccountConfig {
  return mergeAccountConfig<ZaloAccountConfig>({
    channelConfig: cfg.channels?.zalo as ZaloAccountConfig | undefined,
    accountConfig: resolveAccountConfig(cfg, accountId),
    omitKeys: ["defaultAccount"],
  });
}

export function resolveZaloAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  allowUnresolvedSecretRef?: boolean;
}): ResolvedZaloAccount {
  const accountId = normalizeAccountId(params.accountId);
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

export function listEnabledZaloAccounts(cfg: OpenClawConfig): ResolvedZaloAccount[] {
  return listZaloAccountIds(cfg)
    .map((accountId) => resolveZaloAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
