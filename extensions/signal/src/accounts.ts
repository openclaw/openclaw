// Signal plugin module implements accounts behavior.
import {
  createAccountListHelpers,
  normalizeAccountId,
  resolveMergedAccountConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";
import type { SignalAccountConfig } from "./account-types.js";

export type ResolvedSignalAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  baseUrl: string;
  configured: boolean;
  config: SignalAccountConfig;
};

const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("signal", {
  implicitDefaultAccount: {
    channelKeys: ["account"],
  },
});
export const listSignalAccountIds = listAccountIds;
export const resolveDefaultSignalAccountId = resolveDefaultAccountId;

function mergeSignalAccountConfig(cfg: OpenClawConfig, accountId: string): SignalAccountConfig {
  const merged = resolveMergedAccountConfig<SignalAccountConfig>({
    channelConfig: cfg.channels?.signal as SignalAccountConfig | undefined,
    accounts: cfg.channels?.signal?.accounts as
      | Record<string, Partial<SignalAccountConfig>>
      | undefined,
    accountId,
  });
  const rootAccount = normalizeOptionalString(cfg.channels?.signal?.account);
  const rootAccountUuid = normalizeOptionalString(cfg.channels?.signal?.accountUuid);
  const namedAccount = cfg.channels?.signal?.accounts?.[accountId] as
    | Partial<SignalAccountConfig>
    | undefined;
  const namedAccountValue = normalizeOptionalString(namedAccount?.account);
  if (
    rootAccountUuid &&
    namedAccountValue &&
    !normalizeOptionalString(namedAccount?.accountUuid) &&
    (!rootAccount || normalizeE164(namedAccountValue) !== normalizeE164(rootAccount))
  ) {
    const { accountUuid: _accountUuid, ...withoutInheritedAccountUuid } = merged;
    return withoutInheritedAccountUuid as SignalAccountConfig;
  }
  return merged;
}

export function resolveSignalAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedSignalAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultSignalAccountId(params.cfg),
  );
  const baseEnabled = params.cfg.channels?.signal?.enabled !== false;
  const merged = mergeSignalAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const host = normalizeOptionalString(merged.httpHost) ?? "127.0.0.1";
  const port = merged.httpPort ?? 8080;
  const baseUrl = normalizeOptionalString(merged.httpUrl) ?? `http://${host}:${port}`;
  const configured = Boolean(
    normalizeOptionalString(merged.account) ||
    normalizeOptionalString(merged.configPath) ||
    normalizeOptionalString(merged.httpUrl) ||
    normalizeOptionalString(merged.cliPath) ||
    normalizeOptionalString(merged.httpHost) ||
    typeof merged.httpPort === "number" ||
    typeof merged.autoStart === "boolean",
  );
  return {
    accountId,
    enabled,
    name: normalizeOptionalString(merged.name),
    baseUrl,
    configured,
    config: merged,
  };
}

export function listEnabledSignalAccounts(cfg: OpenClawConfig): ResolvedSignalAccount[] {
  return listSignalAccountIds(cfg)
    .map((accountId) => resolveSignalAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
