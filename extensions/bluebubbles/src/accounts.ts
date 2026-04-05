import {
  createAccountListHelpers,
  normalizeAccountId,
  resolveMergedAccountConfig,
} from "mullusi/plugin-sdk/account-resolution";
import type { MullusiConfig } from "mullusi/plugin-sdk/core";
import { hasConfiguredSecretInput, normalizeSecretInputString } from "./secret-input.js";
import { normalizeBlueBubblesServerUrl, type BlueBubblesAccountConfig } from "./types.js";

export type ResolvedBlueBubblesAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  config: BlueBubblesAccountConfig;
  configured: boolean;
  baseUrl?: string;
};

const {
  listAccountIds: listBlueBubblesAccountIds,
  resolveDefaultAccountId: resolveDefaultBlueBubblesAccountId,
} = createAccountListHelpers("bluebubbles");
export { listBlueBubblesAccountIds, resolveDefaultBlueBubblesAccountId };

function mergeBlueBubblesAccountConfig(
  cfg: MullusiConfig,
  accountId: string,
): BlueBubblesAccountConfig {
  const merged = resolveMergedAccountConfig<BlueBubblesAccountConfig>({
    channelConfig: cfg.channels?.bluebubbles as BlueBubblesAccountConfig | undefined,
    accounts: cfg.channels?.bluebubbles?.accounts as
      | Record<string, Partial<BlueBubblesAccountConfig>>
      | undefined,
    accountId,
    omitKeys: ["defaultAccount"],
  });
  return { ...merged, chunkMode: merged.chunkMode ?? "length" };
}

export function resolveBlueBubblesAccount(params: {
  cfg: MullusiConfig;
  accountId?: string | null;
}): ResolvedBlueBubblesAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultBlueBubblesAccountId(params.cfg),
  );
  const baseEnabled = params.cfg.channels?.bluebubbles?.enabled;
  const merged = mergeBlueBubblesAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const serverUrl = normalizeSecretInputString(merged.serverUrl);
  const password = normalizeSecretInputString(merged.password);
  const configured = Boolean(serverUrl && hasConfiguredSecretInput(merged.password));
  const baseUrl = serverUrl ? normalizeBlueBubblesServerUrl(serverUrl) : undefined;
  return {
    accountId,
    enabled: baseEnabled !== false && accountEnabled,
    name: merged.name?.trim() || undefined,
    config: merged,
    configured,
    baseUrl,
  };
}

export function listEnabledBlueBubblesAccounts(cfg: MullusiConfig): ResolvedBlueBubblesAccount[] {
  return listBlueBubblesAccountIds(cfg)
    .map((accountId) => resolveBlueBubblesAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
