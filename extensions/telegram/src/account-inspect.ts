import { resolveAccountWithDefaultFallback } from "openclaw/plugin-sdk/account-core";
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/secret-file-runtime";
import {
  coerceSecretRef,
  hasConfiguredSecretInput,
  normalizeSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import { canResolveEnvSecretRefInReadOnlyPath } from "openclaw/plugin-sdk/secret-ref-readonly";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  listTelegramAccountIds,
  mergeTelegramAccountConfig,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccountConfig,
} from "./accounts.js";

type CredentialUnavailableDiagnostic = Extract<
  ReturnType<typeof tryReadSecretFileSync>,
  { status: "configured_unavailable" }
>["diagnostic"];

export type TelegramCredentialStatus = "available" | "configured_unavailable" | "missing";

type TelegramAccountInspection = {
  accountId: string;
  enabled: boolean;
  name?: string;
  token: string;
  tokenSource: "env" | "tokenFile" | "config" | "none";
  tokenStatus: TelegramCredentialStatus;
  credentialDiagnostics?: CredentialUnavailableDiagnostic[];
  configured: boolean;
  stateReason?: string;
  config: TelegramAccountConfig;
};

export type InspectedTelegramAccount = TelegramAccountInspection & {
  mode: "webhook" | "polling";
  allowUnmentionedGroups: boolean;
};

function inspectTokenFile(
  pathValue: unknown,
  configPath: string,
): {
  token: string;
  tokenSource: "tokenFile" | "none";
  tokenStatus: TelegramCredentialStatus;
  credentialDiagnostics?: CredentialUnavailableDiagnostic[];
} | null {
  const tokenFile = normalizeOptionalString(pathValue) ?? "";
  if (!tokenFile) {
    return null;
  }
  const result = tryReadSecretFileSync(
    tokenFile,
    "Telegram bot token",
    { rejectSymlink: true },
    { configPath },
  );
  if (result.status === "configured_unavailable") {
    return {
      token: "",
      tokenSource: "tokenFile",
      tokenStatus: "configured_unavailable",
      credentialDiagnostics: [result.diagnostic],
    };
  }
  return {
    token: result.status === "available" ? result.value : "",
    tokenSource: "tokenFile",
    tokenStatus: result.status === "available" ? "available" : "configured_unavailable",
  };
}

function inspectTokenValue(params: { cfg: OpenClawConfig; value: unknown }): {
  token: string;
  tokenSource: "config" | "env" | "none";
  tokenStatus: TelegramCredentialStatus;
} | null {
  // Try to resolve env-based SecretRefs from process.env for read-only inspection
  const ref = coerceSecretRef(params.value, params.cfg.secrets?.defaults);
  if (ref?.source === "env") {
    if (
      !canResolveEnvSecretRefInReadOnlyPath({
        cfg: params.cfg,
        provider: ref.provider,
        id: ref.id,
      })
    ) {
      return {
        token: "",
        tokenSource: "env",
        tokenStatus: "configured_unavailable",
      };
    }
    const envValue = normalizeOptionalString(process.env[ref.id]);
    if (envValue) {
      return {
        token: envValue,
        tokenSource: "env",
        tokenStatus: "available",
      };
    }
    return {
      token: "",
      tokenSource: "env",
      tokenStatus: "configured_unavailable",
    };
  }
  const token = normalizeSecretInputString(params.value);
  if (token) {
    return {
      token,
      tokenSource: "config",
      tokenStatus: "available",
    };
  }
  if (hasConfiguredSecretInput(params.value, params.cfg.secrets?.defaults)) {
    return {
      token: "",
      tokenSource: "config",
      tokenStatus: "configured_unavailable",
    };
  }
  return null;
}

function hasConfiguredTelegramAccounts(cfg: OpenClawConfig): boolean {
  const accounts = cfg.channels?.telegram?.accounts;
  return (
    Boolean(accounts) &&
    typeof accounts === "object" &&
    !Array.isArray(accounts) &&
    Object.keys(accounts).length > 0
  );
}

function inspectTelegramAccountPrimary(params: {
  cfg: OpenClawConfig;
  accountId: string;
  envToken?: string | null;
}): TelegramAccountInspection {
  const accountId = normalizeAccountId(params.accountId);
  const merged = mergeTelegramAccountConfig(params.cfg, accountId);
  const enabled = params.cfg.channels?.telegram?.enabled !== false && merged.enabled !== false;

  const accountConfig = resolveTelegramAccountConfig(params.cfg, accountId);
  const allowChannelCredentialFallback =
    accountId === DEFAULT_ACCOUNT_ID ||
    Boolean(accountConfig) ||
    !hasConfiguredTelegramAccounts(params.cfg);
  const credentialScopes = [
    { config: accountConfig, path: `channels.telegram.accounts.${accountId}` },
    ...(allowChannelCredentialFallback
      ? [{ config: params.cfg.channels?.telegram, path: "channels.telegram" }]
      : []),
  ];
  for (const { config, path } of credentialScopes) {
    const credential =
      inspectTokenFile(config?.tokenFile, `${path}.tokenFile`) ??
      inspectTokenValue({ cfg: params.cfg, value: config?.botToken });
    if (credential) {
      return {
        accountId,
        enabled,
        name: normalizeOptionalString(merged.name),
        ...credential,
        configured: credential.tokenStatus !== "missing",
        config: merged,
      };
    }
  }

  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envToken = allowEnv
    ? (normalizeOptionalString(params.envToken) ??
      normalizeOptionalString(process.env.TELEGRAM_BOT_TOKEN) ??
      "")
    : "";
  if (envToken) {
    return {
      accountId,
      enabled,
      name: normalizeOptionalString(merged.name),
      token: envToken,
      tokenSource: "env",
      tokenStatus: "available",
      configured: true,
      config: merged,
    };
  }

  return {
    accountId,
    enabled,
    name: normalizeOptionalString(merged.name),
    token: "",
    tokenSource: "none",
    tokenStatus: "missing",
    configured: false,
    stateReason: allowChannelCredentialFallback
      ? undefined
      : `not configured: unknown accountId "${accountId}" in multi-bot setup`,
    config: merged,
  };
}

function readTelegramAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  envToken?: string | null;
}): TelegramAccountInspection {
  const resolvedAccountId = params.accountId ?? resolveDefaultTelegramAccountId(params.cfg);
  return resolveAccountWithDefaultFallback({
    accountId: resolvedAccountId,
    normalizeAccountId,
    resolvePrimary: (accountId) =>
      inspectTelegramAccountPrimary({
        cfg: params.cfg,
        accountId,
        envToken: params.envToken,
      }),
    hasCredential: (account) => account.tokenSource !== "none",
    resolveDefaultAccountId: () => resolveDefaultTelegramAccountId(params.cfg),
  });
}

export function findTelegramTokenOwnerAccountId(params: {
  cfg: OpenClawConfig;
  accountId: string;
  envToken?: string | null;
}): string | null {
  const normalizedAccountId = normalizeAccountId(params.accountId);
  const tokenOwners = new Map<string, string>();
  for (const id of listTelegramAccountIds(params.cfg)) {
    // Read credentials before policy projection so duplicate inspection cannot recurse.
    const account = readTelegramAccount({ ...params, accountId: id });
    const token = account.token.trim();
    if (!token) {
      continue;
    }
    const ownerAccountId = tokenOwners.get(token);
    if (!ownerAccountId) {
      tokenOwners.set(token, account.accountId);
      continue;
    }
    if (account.accountId === normalizedAccountId) {
      return ownerAccountId;
    }
  }
  return null;
}

export function formatDuplicateTelegramTokenReason(params: {
  accountId: string;
  ownerAccountId: string;
}): string {
  return (
    `Duplicate Telegram bot token: account "${params.accountId}" shares a token with ` +
    `account "${params.ownerAccountId}". Keep one owner account per bot token.`
  );
}

export function inspectTelegramAccount(
  params: Parameters<typeof readTelegramAccount>[0],
): InspectedTelegramAccount {
  const account = readTelegramAccount(params);
  const ownerAccountId = account.token
    ? findTelegramTokenOwnerAccountId({ ...params, accountId: account.accountId })
    : null;
  const groups =
    params.cfg.channels?.telegram?.accounts?.[account.accountId]?.groups ??
    params.cfg.channels?.telegram?.groups;
  return {
    ...account,
    configured: account.configured && !ownerAccountId,
    stateReason: ownerAccountId
      ? formatDuplicateTelegramTokenReason({ accountId: account.accountId, ownerAccountId })
      : account.stateReason,
    mode: account.config.webhookUrl ? "webhook" : "polling",
    allowUnmentionedGroups: Object.values(groups ?? {}).some(
      (group) => group?.requireMention === false,
    ),
  };
}
