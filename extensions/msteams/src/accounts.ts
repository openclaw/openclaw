import {
  createAccountListHelpers,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/secret-file-runtime";
import type { MSTeamsConfig, OpenClawConfig } from "../runtime-api.js";
import { resolveMSTeamsWebhookPath } from "./accounts-webhook.js";
import {
  hasConfiguredMSTeamsCredentials,
  inspectMSTeamsCredentials,
  resolveMSTeamsCredentials,
} from "./token-config.js";

export type ResolvedMSTeamsAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  tokenStatus: "available" | "configured_unavailable" | "missing";
  credentialDiagnostics?: Extract<
    ReturnType<typeof tryReadSecretFileSync>,
    { status: "configured_unavailable" }
  >["diagnostic"][];
  config: MSTeamsConfig;
};

const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("msteams", {
  normalizeAccountId,
  hasImplicitDefaultAccount: (cfg) => hasConfiguredMSTeamsCredentials(cfg.channels?.msteams),
});

export const listMSTeamsAccountIds = listAccountIds;
export const resolveDefaultMSTeamsAccountId = resolveDefaultAccountId;

export function withAccountScopedMSTeamsConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  accountConfig: MSTeamsConfig;
}): OpenClawConfig {
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      msteams:
        params.accountId === DEFAULT_ACCOUNT_ID
          ? params.accountConfig
          : { ...params.accountConfig, defaultAccount: params.accountId },
    },
  };
}

function accountDefinesIdentity(account: Partial<MSTeamsConfig> | undefined): boolean {
  return Boolean(account?.appId || account?.appPassword);
}

function resolveMSTeamsAccountEntry(
  accounts: Record<string, Partial<MSTeamsConfig>> | undefined,
  accountId: string,
): Partial<MSTeamsConfig> | undefined {
  const key = resolveMSTeamsAccountEntryKey(accounts, accountId);
  return key ? accounts?.[key] : undefined;
}

export function resolveMSTeamsAccountEntryKey(
  accounts: Record<string, Partial<MSTeamsConfig>> | undefined,
  accountId: string,
): string | undefined {
  if (!accounts) {
    return undefined;
  }
  for (const key of Object.keys(accounts)) {
    if (normalizeAccountId(key) === accountId) {
      return key;
    }
  }
  return undefined;
}

export function resolveMSTeamsAccountConfigPath(cfg: OpenClawConfig, accountId: string): string {
  const normalized = normalizeAccountId(accountId);
  const rawAccountKey = resolveMSTeamsAccountEntryKey(cfg.channels?.msteams?.accounts, normalized);
  if (rawAccountKey) {
    return `channels.msteams.accounts.${rawAccountKey}`;
  }
  return normalized === DEFAULT_ACCOUNT_ID
    ? "channels.msteams"
    : `channels.msteams.accounts.${normalized}`;
}

function isAccountScopedChannelConfig(
  channelConfig: MSTeamsConfig | undefined,
  accountId: string,
): boolean {
  if (!channelConfig) {
    return false;
  }
  const accounts = channelConfig.accounts;
  return (
    normalizeAccountId(channelConfig.defaultAccount) === accountId &&
    (!accounts || Object.keys(accounts).length === 0) &&
    accountDefinesIdentity(channelConfig)
  );
}

function clearNamedAccountInheritedIdentity(
  merged: MSTeamsConfig,
  account: Partial<MSTeamsConfig> | undefined,
): MSTeamsConfig {
  const next: MSTeamsConfig = { ...merged };
  if (account?.appId === undefined) {
    delete next.appId;
  }
  if (account?.appPassword === undefined) {
    delete next.appPassword;
  }
  if (account?.legacyWebhook === undefined) {
    delete next.legacyWebhook;
  }
  return next;
}

export function resolveMSTeamsAccountConfig(
  cfg: OpenClawConfig,
  accountId?: string | null,
): MSTeamsConfig {
  const resolvedAccountId = normalizeAccountId(accountId ?? resolveDefaultMSTeamsAccountId(cfg));
  const channelConfig = cfg.channels?.msteams;
  const account = resolveMSTeamsAccountEntry(channelConfig?.accounts, resolvedAccountId);
  const merged = resolveMergedAccountConfig<MSTeamsConfig>({
    channelConfig,
    accounts: channelConfig?.accounts,
    accountId: resolvedAccountId,
    normalizeAccountId,
    omitKeys: ["defaultAccount"],
    nestedObjectKeys: [
      "webhook",
      "markdown",
      "streaming",
      "blockStreamingCoalesce",
      "dms",
      "teams",
      "heartbeat",
      "healthMonitor",
      "delegatedAuth",
      "sso",
    ],
  });

  if (
    resolvedAccountId === DEFAULT_ACCOUNT_ID ||
    (!account && isAccountScopedChannelConfig(channelConfig, resolvedAccountId))
  ) {
    return merged;
  }
  const config = clearNamedAccountInheritedIdentity(merged, account);
  return {
    ...config,
    webhook: {
      ...config.webhook,
      path: resolveMSTeamsWebhookPath(channelConfig, resolvedAccountId, account),
    },
  };
}

export function resolveMSTeamsRuntimeAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  msteamsCfg?: MSTeamsConfig;
}) {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultMSTeamsAccountId(params.cfg),
  );
  const config = params.msteamsCfg ?? resolveMSTeamsAccountConfig(params.cfg, accountId);
  const credentials = resolveMSTeamsCredentials(config, {
    allowEnvFallback: accountId === DEFAULT_ACCOUNT_ID,
    pathPrefix: resolveMSTeamsAccountConfigPath(params.cfg, accountId),
  });
  return { accountId, config, credentials };
}

function resolveMSTeamsAccountWithMode(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  mode: "runtime" | "inspect";
}): ResolvedMSTeamsAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultMSTeamsAccountId(params.cfg),
  );
  const channelEnabled = params.cfg.channels?.msteams?.enabled !== false;
  const config = resolveMSTeamsAccountConfig(params.cfg, accountId);
  const accountEnabled = config.enabled !== false;
  const pathPrefix = resolveMSTeamsAccountConfigPath(params.cfg, accountId);
  const credentialResolution =
    params.mode === "inspect"
      ? inspectMSTeamsCredentials(config, {
          allowEnvFallback: accountId === DEFAULT_ACCOUNT_ID,
        })
      : (() => {
          const credentials = resolveMSTeamsCredentials(config, {
            allowEnvFallback: accountId === DEFAULT_ACCOUNT_ID,
            pathPrefix,
          });
          return {
            credentials,
            status: credentials ? ("available" as const) : ("missing" as const),
          };
        })();
  const credentials = credentialResolution.credentials;
  const certificatePath =
    credentials?.type === "federated" && !credentials.useManagedIdentity
      ? credentials.certificatePath
      : undefined;
  const channelConfig = params.cfg.channels?.msteams;
  const rawAccountKey = resolveMSTeamsAccountEntryKey(channelConfig?.accounts, accountId);
  const rawAccount = rawAccountKey ? channelConfig?.accounts?.[rawAccountKey] : undefined;
  const certificateConfigPath = rawAccount?.certificatePath?.trim()
    ? `channels.msteams.accounts.${rawAccountKey}.certificatePath`
    : channelConfig?.certificatePath?.trim()
      ? "channels.msteams.certificatePath"
      : "env.MSTEAMS_CERTIFICATE_PATH";
  const certificate = certificatePath
    ? tryReadSecretFileSync(certificatePath, "Microsoft Teams certificate", undefined, {
        configPath: certificateConfigPath,
      })
    : undefined;
  const unavailable =
    credentialResolution.status === "configured_unavailable" ||
    certificate?.status === "configured_unavailable";
  const credentialDiagnostics =
    certificate?.status === "configured_unavailable" ? [certificate.diagnostic] : undefined;
  return {
    accountId,
    enabled: channelEnabled && accountEnabled,
    configured: credentialResolution.status !== "missing",
    tokenStatus:
      credentialResolution.status === "missing"
        ? "missing"
        : unavailable
          ? "configured_unavailable"
          : "available",
    ...(credentialDiagnostics ? { credentialDiagnostics } : {}),
    config,
  };
}

export function resolveMSTeamsAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedMSTeamsAccount {
  return resolveMSTeamsAccountWithMode({ ...params, mode: "runtime" });
}

export function inspectMSTeamsAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): Record<string, unknown> {
  const account = resolveMSTeamsAccountWithMode({ ...params, mode: "inspect" });
  return {
    accountId: account.accountId,
    enabled: account.enabled,
    configured: account.configured,
    tokenStatus: account.tokenStatus,
    ...(account.credentialDiagnostics
      ? { credentialDiagnostics: account.credentialDiagnostics }
      : {}),
    hasIdentity:
      account.accountId === DEFAULT_ACCOUNT_ID ||
      accountDefinesIdentity(
        resolveMSTeamsAccountEntry(params.cfg.channels?.msteams?.accounts, account.accountId),
      ),
    path: account.config.webhook?.path ?? "/api/messages",
  };
}
