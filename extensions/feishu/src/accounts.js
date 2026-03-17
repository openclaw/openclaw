import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { normalizeResolvedSecretInputString, normalizeSecretInputString } from "./secret-input.js";
function listConfiguredAccountIds(cfg) {
  const accounts = cfg.channels?.feishu?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}
function listFeishuAccountIds(cfg) {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return [...ids].toSorted((a, b) => a.localeCompare(b));
}
function resolveDefaultFeishuAccountSelection(cfg) {
  const preferredRaw = cfg.channels?.feishu?.defaultAccount?.trim();
  const preferred = preferredRaw ? normalizeAccountId(preferredRaw) : void 0;
  if (preferred) {
    return {
      accountId: preferred,
      source: "explicit-default"
    };
  }
  const ids = listFeishuAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return {
      accountId: DEFAULT_ACCOUNT_ID,
      source: "mapped-default"
    };
  }
  return {
    accountId: ids[0] ?? DEFAULT_ACCOUNT_ID,
    source: "fallback"
  };
}
function resolveDefaultFeishuAccountId(cfg) {
  return resolveDefaultFeishuAccountSelection(cfg).accountId;
}
function resolveAccountConfig(cfg, accountId) {
  const accounts = cfg.channels?.feishu?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return void 0;
  }
  return accounts[accountId];
}
function mergeFeishuAccountConfig(cfg, accountId) {
  const feishuCfg = cfg.channels?.feishu;
  const { accounts: _ignored, defaultAccount: _ignoredDefaultAccount, ...base } = feishuCfg ?? {};
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}
function resolveFeishuCredentials(cfg, options) {
  const normalizeString = (value) => {
    if (typeof value !== "string") {
      return void 0;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : void 0;
  };
  const resolveSecretLike = (value, path) => {
    const asString = normalizeString(value);
    if (asString) {
      return asString;
    }
    if (options?.allowUnresolvedSecretRef && typeof value === "object" && value !== null) {
      const rec = value;
      const source = normalizeString(rec.source)?.toLowerCase();
      const id = normalizeString(rec.id);
      if (source === "env" && id) {
        const envValue = normalizeString(process.env[id]);
        if (envValue) {
          return envValue;
        }
      }
    }
    if (options?.allowUnresolvedSecretRef) {
      return normalizeSecretInputString(value);
    }
    return normalizeResolvedSecretInputString({ value, path });
  };
  const appId = resolveSecretLike(cfg?.appId, "channels.feishu.appId");
  const appSecret = resolveSecretLike(cfg?.appSecret, "channels.feishu.appSecret");
  if (!appId || !appSecret) {
    return null;
  }
  const connectionMode = cfg?.connectionMode ?? "websocket";
  return {
    appId,
    appSecret,
    encryptKey: connectionMode === "webhook" ? resolveSecretLike(cfg?.encryptKey, "channels.feishu.encryptKey") : normalizeString(cfg?.encryptKey),
    verificationToken: resolveSecretLike(
      cfg?.verificationToken,
      "channels.feishu.verificationToken"
    ),
    domain: cfg?.domain ?? "feishu"
  };
}
function resolveFeishuAccount(params) {
  const hasExplicitAccountId = typeof params.accountId === "string" && params.accountId.trim() !== "";
  const defaultSelection = hasExplicitAccountId ? null : resolveDefaultFeishuAccountSelection(params.cfg);
  const accountId = hasExplicitAccountId ? normalizeAccountId(params.accountId) : defaultSelection?.accountId ?? DEFAULT_ACCOUNT_ID;
  const selectionSource = hasExplicitAccountId ? "explicit" : defaultSelection?.source ?? "fallback";
  const feishuCfg = params.cfg.channels?.feishu;
  const baseEnabled = feishuCfg?.enabled !== false;
  const merged = mergeFeishuAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const creds = resolveFeishuCredentials(merged);
  const accountName = merged.name;
  return {
    accountId,
    selectionSource,
    enabled,
    configured: Boolean(creds),
    name: typeof accountName === "string" ? accountName.trim() || void 0 : void 0,
    appId: creds?.appId,
    appSecret: creds?.appSecret,
    encryptKey: creds?.encryptKey,
    verificationToken: creds?.verificationToken,
    domain: creds?.domain ?? "feishu",
    config: merged
  };
}
function listEnabledFeishuAccounts(cfg) {
  return listFeishuAccountIds(cfg).map((accountId) => resolveFeishuAccount({ cfg, accountId })).filter((account) => account.enabled && account.configured);
}
export {
  listEnabledFeishuAccounts,
  listFeishuAccountIds,
  resolveDefaultFeishuAccountId,
  resolveDefaultFeishuAccountSelection,
  resolveFeishuAccount,
  resolveFeishuCredentials
};
