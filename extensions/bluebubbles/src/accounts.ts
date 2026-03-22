import { createAccountListHelpers, mergeAccountConfig } from "openclaw/plugin-sdk/account-helpers";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
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

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): BlueBubblesAccountConfig | undefined {
  const accounts = cfg.channels?.bluebubbles?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId] as BlueBubblesAccountConfig | undefined;
}

function mergeBlueBubblesAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): BlueBubblesAccountConfig {
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  const merged = mergeAccountConfig<BlueBubblesAccountConfig>({
    channelConfig: cfg.channels?.bluebubbles as BlueBubblesAccountConfig | undefined,
    accountConfig: account,
    omitKeys: ["defaultAccount"],
  });
  const chunkMode = account.chunkMode ?? merged.chunkMode ?? "length";
  return { ...merged, chunkMode };
}

export function resolveBlueBubblesAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedBlueBubblesAccount {
  const accountId = normalizeAccountId(params.accountId);
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

export function listEnabledBlueBubblesAccounts(cfg: OpenClawConfig): ResolvedBlueBubblesAccount[] {
  return listBlueBubblesAccountIds(cfg)
    .map((accountId) => resolveBlueBubblesAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
