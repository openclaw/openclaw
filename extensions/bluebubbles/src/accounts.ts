import {
  createAccountListHelpers,
  normalizeAccountId,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-resolution";
import { resolveChannelStreamingChunkMode } from "openclaw/plugin-sdk/channel-streaming";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { isBlockedHostnameOrIp } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeBlueBubblesPrivateNetworkAliases(
  config: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const record = asRecord(config);
  if (!record) {
    return config;
  }
  const network = asRecord(record.network);
  const canonicalValue =
    typeof network?.dangerouslyAllowPrivateNetwork === "boolean"
      ? network.dangerouslyAllowPrivateNetwork
      : typeof network?.allowPrivateNetwork === "boolean"
        ? network.allowPrivateNetwork
        : typeof record.dangerouslyAllowPrivateNetwork === "boolean"
          ? record.dangerouslyAllowPrivateNetwork
          : typeof record.allowPrivateNetwork === "boolean"
            ? record.allowPrivateNetwork
            : undefined;

  if (canonicalValue === undefined) {
    return config;
  }

  const {
    allowPrivateNetwork: _legacyFlatAllow,
    dangerouslyAllowPrivateNetwork: _legacyFlatDanger,
    ...rest
  } = record;
  const {
    allowPrivateNetwork: _legacyNetworkAllow,
    dangerouslyAllowPrivateNetwork: _legacyNetworkDanger,
    ...restNetwork
  } = network ?? {};

  return {
    ...rest,
    network: {
      ...restNetwork,
      dangerouslyAllowPrivateNetwork: canonicalValue,
    },
  };
}

function normalizeBlueBubblesAccountsMap(
  accounts: Record<string, Partial<BlueBubblesAccountConfig>> | undefined,
): Record<string, Partial<BlueBubblesAccountConfig>> | undefined {
  if (!accounts) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(accounts).map(([accountKey, accountConfig]) => [
      accountKey,
      normalizeBlueBubblesPrivateNetworkAliases(accountConfig) as Partial<BlueBubblesAccountConfig>,
    ]),
  );
}

function mergeBlueBubblesAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): BlueBubblesAccountConfig {
  const channelConfig = normalizeBlueBubblesPrivateNetworkAliases(
    cfg.channels?.bluebubbles as BlueBubblesAccountConfig | undefined,
  ) as BlueBubblesAccountConfig | undefined;
  const accounts = normalizeBlueBubblesAccountsMap(
    cfg.channels?.bluebubbles?.accounts as
      | Record<string, Partial<BlueBubblesAccountConfig>>
      | undefined,
  );
  const merged = resolveMergedAccountConfig<BlueBubblesAccountConfig>({
    channelConfig,
    accounts,
    accountId,
    omitKeys: ["defaultAccount"],
    normalizeAccountId,
    nestedObjectKeys: ["network"],
  });
  return {
    ...merged,
    chunkMode: resolveChannelStreamingChunkMode(merged) ?? merged.chunkMode ?? "length",
  };
}

export function resolveBlueBubblesAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedBlueBubblesAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultBlueBubblesAccountId(params.cfg),
  );
  const baseEnabled = params.cfg.channels?.bluebubbles?.enabled;
  const merged = mergeBlueBubblesAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const serverUrl = normalizeSecretInputString(merged.serverUrl);
  const _password = normalizeSecretInputString(merged.password);
  const configured = Boolean(serverUrl && hasConfiguredSecretInput(merged.password));
  const baseUrl = serverUrl ? normalizeBlueBubblesServerUrl(serverUrl) : undefined;
  return {
    accountId,
    enabled: baseEnabled !== false && accountEnabled,
    name: normalizeOptionalString(merged.name),
    config: merged,
    configured,
    baseUrl,
  };
}

export function resolveBlueBubblesPrivateNetworkConfigValue(
  config: BlueBubblesAccountConfig | null | undefined,
): boolean | undefined {
  const record = asRecord(config);
  if (!record) {
    return undefined;
  }
  const network = asRecord(record.network);
  if (typeof network?.dangerouslyAllowPrivateNetwork === "boolean") {
    return network.dangerouslyAllowPrivateNetwork;
  }
  if (typeof network?.allowPrivateNetwork === "boolean") {
    return network.allowPrivateNetwork;
  }
  if (typeof record.dangerouslyAllowPrivateNetwork === "boolean") {
    return record.dangerouslyAllowPrivateNetwork;
  }
  if (typeof record.allowPrivateNetwork === "boolean") {
    return record.allowPrivateNetwork;
  }
  return undefined;
}

export function resolveBlueBubblesEffectiveAllowPrivateNetwork(params: {
  baseUrl?: string;
  config?: BlueBubblesAccountConfig | null;
}): boolean {
  const configuredValue = resolveBlueBubblesPrivateNetworkConfigValue(params.config);
  if (configuredValue !== undefined) {
    return configuredValue;
  }
  if (!params.baseUrl) {
    return false;
  }
  try {
    const hostname = new URL(normalizeBlueBubblesServerUrl(params.baseUrl)).hostname.trim();
    return Boolean(hostname) && isBlockedHostnameOrIp(hostname);
  } catch {
    return false;
  }
}

export function listEnabledBlueBubblesAccounts(cfg: OpenClawConfig): ResolvedBlueBubblesAccount[] {
  return listBlueBubblesAccountIds(cfg)
    .map((accountId) => resolveBlueBubblesAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
