import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/routing";
import {
  coerceSecretRef,
  hasConfiguredSecretInput,
  normalizeSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import { canResolveEnvSecretRefInReadOnlyPath } from "openclaw/plugin-sdk/secret-ref-readonly";
import {
  asNonArrayRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  listTelegramAccountIds,
  mergeTelegramAccountConfig,
  resolveTelegramAccountConfig,
  resolveTelegramAccountFallback,
  type ResolvedTelegramAccount,
} from "./accounts.js";
import { readTelegramTokenFile } from "./token.js";

type InspectedTelegramCredential = Pick<
  ResolvedTelegramAccount,
  "token" | "tokenSource" | "tokenStatus" | "credentialDiagnostics"
>;

export type TelegramCredentialStatus = ResolvedTelegramAccount["tokenStatus"];

type TelegramAccountInspection = ResolvedTelegramAccount & {
  configured: boolean;
  stateReason?: string;
};

export type InspectedTelegramAccount = TelegramAccountInspection & {
  mode: "webhook" | "polling";
  allowUnmentionedGroups: boolean;
};

function inspectTokenFile(
  pathValue: unknown,
  configPath: string,
): InspectedTelegramCredential | null {
  const tokenFile = normalizeOptionalString(pathValue) ?? "";
  if (!tokenFile) {
    return null;
  }
  const result = readTelegramTokenFile(tokenFile, configPath);
  return {
    token: result.token,
    tokenSource: result.source,
    tokenStatus: result.credentialDiagnostics ? "configured_unavailable" : "available",
    ...(result.credentialDiagnostics
      ? { credentialDiagnostics: result.credentialDiagnostics }
      : {}),
  };
}

function inspectTokenValue(params: {
  cfg: OpenClawConfig;
  value: unknown;
}): InspectedTelegramCredential | null {
  const ref = coerceSecretRef(params.value, params.cfg.secrets?.defaults);
  if (ref?.source === "env") {
    const envValue = canResolveEnvSecretRefInReadOnlyPath({
      cfg: params.cfg,
      provider: ref.provider,
      id: ref.id,
    })
      ? normalizeOptionalString(process.env[ref.id])
      : undefined;
    return {
      token: envValue ?? "",
      tokenSource: "env",
      tokenStatus: envValue ? "available" : "configured_unavailable",
    };
  }
  const token = normalizeSecretInputString(params.value);
  if (token || hasConfiguredSecretInput(params.value, params.cfg.secrets?.defaults)) {
    return {
      token: token || "",
      tokenSource: "config",
      tokenStatus: token ? "available" : "configured_unavailable",
    };
  }
  return null;
}

function hasConfiguredTelegramAccounts(cfg: OpenClawConfig): boolean {
  return Object.keys(asNonArrayRecord(cfg.channels?.telegram?.accounts)).length > 0;
}

function inspectTelegramAccountPrimary(params: {
  cfg: OpenClawConfig;
  accountId: string;
  envToken?: string | null;
}): TelegramAccountInspection {
  const accountId = normalizeAccountId(params.accountId);
  const merged = mergeTelegramAccountConfig(params.cfg, accountId);
  const enabled = params.cfg.channels?.telegram?.enabled !== false && merged.enabled !== false;
  const account = {
    accountId,
    enabled,
    name: normalizeOptionalString(merged.name),
    config: merged,
  };

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
        ...account,
        ...credential,
        configured: credential.tokenStatus !== "missing",
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
      ...account,
      token: envToken,
      tokenSource: "env",
      tokenStatus: "available",
      configured: true,
    };
  }

  return {
    ...account,
    token: "",
    tokenSource: "none",
    tokenStatus: "missing",
    configured: false,
    stateReason: allowChannelCredentialFallback
      ? undefined
      : `not configured: unknown accountId "${accountId}" in multi-bot setup`,
  };
}

function readTelegramAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  envToken?: string | null;
}): TelegramAccountInspection {
  return resolveTelegramAccountFallback(params, (accountId) =>
    inspectTelegramAccountPrimary({ cfg: params.cfg, accountId, envToken: params.envToken }),
  );
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
