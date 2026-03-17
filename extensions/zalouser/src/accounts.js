import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { createAccountListHelpers } from "openclaw/plugin-sdk/zalouser";
import { checkZaloAuthenticated, getZaloUserInfo } from "./zalo-js.js";
const {
  listAccountIds: listZalouserAccountIds,
  resolveDefaultAccountId: resolveDefaultZalouserAccountId
} = createAccountListHelpers("zalouser");
function resolveAccountConfig(cfg, accountId) {
  const accounts = cfg.channels?.zalouser?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return void 0;
  }
  return accounts[accountId];
}
function mergeZalouserAccountConfig(cfg, accountId) {
  const raw = cfg.channels?.zalouser ?? {};
  const { accounts: _ignored, defaultAccount: _ignored2, ...base } = raw;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}
function resolveProfile(config, accountId) {
  if (config.profile?.trim()) {
    return config.profile.trim();
  }
  if (process.env.ZALOUSER_PROFILE?.trim()) {
    return process.env.ZALOUSER_PROFILE.trim();
  }
  if (process.env.ZCA_PROFILE?.trim()) {
    return process.env.ZCA_PROFILE.trim();
  }
  if (accountId !== DEFAULT_ACCOUNT_ID) {
    return accountId;
  }
  return "default";
}
function resolveZalouserAccountBase(params) {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.zalouser?.enabled !== false;
  const merged = mergeZalouserAccountConfig(params.cfg, accountId);
  return {
    accountId,
    enabled: baseEnabled && merged.enabled !== false,
    merged,
    profile: resolveProfile(merged, accountId)
  };
}
async function resolveZalouserAccount(params) {
  const { accountId, enabled, merged, profile } = resolveZalouserAccountBase(params);
  const authenticated = await checkZaloAuthenticated(profile);
  return {
    accountId,
    name: merged.name?.trim() || void 0,
    enabled,
    profile,
    authenticated,
    config: merged
  };
}
function resolveZalouserAccountSync(params) {
  const { accountId, enabled, merged, profile } = resolveZalouserAccountBase(params);
  return {
    accountId,
    name: merged.name?.trim() || void 0,
    enabled,
    profile,
    authenticated: false,
    config: merged
  };
}
async function listEnabledZalouserAccounts(cfg) {
  const ids = listZalouserAccountIds(cfg);
  const accounts = await Promise.all(
    ids.map((accountId) => resolveZalouserAccount({ cfg, accountId }))
  );
  return accounts.filter((account) => account.enabled);
}
async function getZcaUserInfo(profile) {
  const info = await getZaloUserInfo(profile);
  if (!info) {
    return null;
  }
  return {
    userId: info.userId,
    displayName: info.displayName
  };
}
export {
  checkZaloAuthenticated as checkZcaAuthenticated,
  getZcaUserInfo,
  listEnabledZalouserAccounts,
  listZalouserAccountIds,
  resolveDefaultZalouserAccountId,
  resolveZalouserAccount,
  resolveZalouserAccountSync
};
