import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { isSecretRef } from "openclaw/plugin-sdk/googlechat";
import { createAccountListHelpers } from "openclaw/plugin-sdk/googlechat";
const ENV_SERVICE_ACCOUNT = "GOOGLE_CHAT_SERVICE_ACCOUNT";
const ENV_SERVICE_ACCOUNT_FILE = "GOOGLE_CHAT_SERVICE_ACCOUNT_FILE";
const {
  listAccountIds: listGoogleChatAccountIds,
  resolveDefaultAccountId: resolveDefaultGoogleChatAccountId
} = createAccountListHelpers("googlechat");
function resolveAccountConfig(cfg, accountId) {
  const accounts = cfg.channels?.["googlechat"]?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return void 0;
  }
  return accounts[accountId];
}
function mergeGoogleChatAccountConfig(cfg, accountId) {
  const raw = cfg.channels?.["googlechat"] ?? {};
  const { accounts: _ignored, defaultAccount: _ignored2, ...base } = raw;
  const defaultAccountConfig = resolveAccountConfig(cfg, DEFAULT_ACCOUNT_ID) ?? {};
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return { ...base, ...defaultAccountConfig };
  }
  const {
    enabled: _ignoredEnabled,
    dangerouslyAllowNameMatching: _ignoredDangerouslyAllowNameMatching,
    serviceAccount: _ignoredServiceAccount,
    serviceAccountRef: _ignoredServiceAccountRef,
    serviceAccountFile: _ignoredServiceAccountFile,
    ...defaultAccountShared
  } = defaultAccountConfig;
  return { ...defaultAccountShared, ...base, ...account };
}
function parseServiceAccount(value) {
  if (value && typeof value === "object") {
    if (isSecretRef(value)) {
      return null;
    }
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}
function resolveCredentialsFromConfig(params) {
  const { account, accountId } = params;
  const inline = parseServiceAccount(account.serviceAccount);
  if (inline) {
    return { credentials: inline, source: "inline" };
  }
  if (isSecretRef(account.serviceAccount)) {
    throw new Error(
      `channels.googlechat.accounts.${accountId}.serviceAccount: unresolved SecretRef "${account.serviceAccount.source}:${account.serviceAccount.provider}:${account.serviceAccount.id}". Resolve this command against an active gateway runtime snapshot before reading it.`
    );
  }
  if (isSecretRef(account.serviceAccountRef)) {
    throw new Error(
      `channels.googlechat.accounts.${accountId}.serviceAccount: unresolved SecretRef "${account.serviceAccountRef.source}:${account.serviceAccountRef.provider}:${account.serviceAccountRef.id}". Resolve this command against an active gateway runtime snapshot before reading it.`
    );
  }
  const file = account.serviceAccountFile?.trim();
  if (file) {
    return { credentialsFile: file, source: "file" };
  }
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const envJson = process.env[ENV_SERVICE_ACCOUNT];
    const envInline = parseServiceAccount(envJson);
    if (envInline) {
      return { credentials: envInline, source: "env" };
    }
    const envFile = process.env[ENV_SERVICE_ACCOUNT_FILE]?.trim();
    if (envFile) {
      return { credentialsFile: envFile, source: "env" };
    }
  }
  return { source: "none" };
}
function resolveGoogleChatAccount(params) {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.["googlechat"]?.enabled !== false;
  const merged = mergeGoogleChatAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const credentials = resolveCredentialsFromConfig({ accountId, account: merged });
  return {
    accountId,
    name: merged.name?.trim() || void 0,
    enabled,
    config: merged,
    credentialSource: credentials.source,
    credentials: credentials.credentials,
    credentialsFile: credentials.credentialsFile
  };
}
function listEnabledGoogleChatAccounts(cfg) {
  return listGoogleChatAccountIds(cfg).map((accountId) => resolveGoogleChatAccount({ cfg, accountId })).filter((account) => account.enabled);
}
export {
  listEnabledGoogleChatAccounts,
  listGoogleChatAccountIds,
  resolveDefaultGoogleChatAccountId,
  resolveGoogleChatAccount
};
