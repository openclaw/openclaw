import {
  createAccountListHelpers,
  normalizeAccountId,
  resolveMergedAccountConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { hasConfiguredSecretInput, normalizeSecretInputString } from "./secret-input.js";
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_SEND_TIMEOUT_MS,
  type CoreConfig,
  type ResolvedVesicleAccount,
  type VesicleAccountConfig,
} from "./types.js";
import { normalizeVesicleServerUrl } from "./url.js";

const {
  listAccountIds: listVesicleAccountIds,
  resolveDefaultAccountId: resolveDefaultVesicleAccountId,
} = createAccountListHelpers("vesicle");

export { listVesicleAccountIds, resolveDefaultVesicleAccountId };
export type { ResolvedVesicleAccount } from "./types.js";

function mergeVesicleAccountConfig(cfg: OpenClawConfig, accountId: string): VesicleAccountConfig {
  const coreCfg = cfg as CoreConfig;
  return resolveMergedAccountConfig<VesicleAccountConfig>({
    channelConfig: coreCfg.channels?.vesicle as VesicleAccountConfig | undefined,
    accounts: coreCfg.channels?.vesicle?.accounts,
    accountId,
    omitKeys: ["defaultAccount"],
    normalizeAccountId,
    nestedObjectKeys: ["network"],
  });
}

export function resolveVesicleAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedVesicleAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultVesicleAccountId(params.cfg),
  );
  const coreCfg = params.cfg as CoreConfig;
  const baseEnabled = coreCfg.channels?.vesicle?.enabled !== false;
  const merged = mergeVesicleAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const serverUrl = normalizeSecretInputString(merged.serverUrl);
  const configured = Boolean(serverUrl && hasConfiguredSecretInput(merged.authToken));
  const baseUrl = serverUrl ? normalizeVesicleServerUrl(serverUrl) : undefined;
  return {
    accountId,
    enabled: baseEnabled && accountEnabled,
    name: normalizeOptionalString(merged.name),
    config: merged,
    configured,
    baseUrl,
  };
}

export function listEnabledVesicleAccounts(cfg: OpenClawConfig): ResolvedVesicleAccount[] {
  return listVesicleAccountIds(cfg)
    .map((accountId) => resolveVesicleAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}

export function resolveVesicleEffectiveAllowPrivateNetwork(params: {
  baseUrl?: string;
  config?: VesicleAccountConfig | null;
}): boolean {
  const config = params.config as
    | (VesicleAccountConfig & { dangerouslyAllowPrivateNetwork?: boolean })
    | null
    | undefined;
  return (
    config?.network?.dangerouslyAllowPrivateNetwork === true ||
    config?.dangerouslyAllowPrivateNetwork === true
  );
}

export function resolveVesicleServerAccount(params: {
  cfg?: OpenClawConfig;
  accountId?: string | null;
  serverUrl?: string | null;
  authToken?: string | null;
  allowPrivateNetwork?: boolean;
}): {
  accountId: string;
  baseUrl: string;
  authToken: string;
  sendTimeoutMs: number;
  probeTimeoutMs: number;
  allowPrivateNetwork: boolean;
  allowPrivateNetworkConfig?: boolean;
} {
  const cfg = (params.cfg ?? {}) as CoreConfig;
  const account = resolveVesicleAccount({
    cfg,
    accountId: params.accountId,
  });
  const serverUrl =
    normalizeSecretInputString(params.serverUrl) ??
    normalizeSecretInputString(account.config.serverUrl) ??
    account.baseUrl;
  const authToken =
    normalizeSecretInputString(params.authToken) ??
    normalizeSecretInputString(account.config.authToken);
  if (!serverUrl) {
    throw new Error("Vesicle serverUrl is required");
  }
  if (!authToken) {
    throw new Error("Vesicle authToken is required");
  }
  const allowPrivateNetworkConfig =
    account.config.network?.dangerouslyAllowPrivateNetwork ??
    (account.config as { dangerouslyAllowPrivateNetwork?: boolean }).dangerouslyAllowPrivateNetwork;
  return {
    accountId: account.accountId,
    baseUrl: normalizeVesicleServerUrl(serverUrl),
    authToken,
    sendTimeoutMs: account.config.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS,
    probeTimeoutMs: account.config.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    allowPrivateNetwork:
      params.allowPrivateNetwork ??
      resolveVesicleEffectiveAllowPrivateNetwork({
        baseUrl: account.baseUrl,
        config: account.config,
      }),
    allowPrivateNetworkConfig,
  };
}
