import {
  createAccountListHelpers,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-helpers";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { resolveVkToken } from "./token.js";
import type { ResolvedVkAccount, VkAccountConfig, VkConfig } from "./types.js";

export type { ResolvedVkAccount };

const { listAccountIds: listVkAccountIds, resolveDefaultAccountId: resolveDefaultVkAccountId } =
  createAccountListHelpers("vk");

export { listVkAccountIds, resolveDefaultVkAccountId };

function mergeVkAccountConfig(cfg: OpenClawConfig, accountId: string): VkAccountConfig {
  return resolveMergedAccountConfig<VkAccountConfig>({
    channelConfig: cfg.channels?.vk as VkAccountConfig | undefined,
    accounts: (cfg.channels?.vk as VkConfig | undefined)?.accounts as
      | Record<string, Partial<VkAccountConfig>>
      | undefined,
    accountId,
    omitKeys: ["defaultAccount"],
  });
}

export function resolveVkAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  allowUnresolvedSecretRef?: boolean;
}): ResolvedVkAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = (params.cfg.channels?.vk as VkConfig | undefined)?.enabled !== false;
  const merged = mergeVkAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const tokenResolution = resolveVkToken(
    params.cfg.channels?.vk as VkConfig | undefined,
    accountId,
    {
      allowUnresolvedSecretRef: params.allowUnresolvedSecretRef,
    },
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
