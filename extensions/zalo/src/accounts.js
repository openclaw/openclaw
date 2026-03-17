import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { createAccountListHelpers } from "openclaw/plugin-sdk/zalo";
import { resolveZaloToken } from "./token.js";
const { listAccountIds: listZaloAccountIds, resolveDefaultAccountId: resolveDefaultZaloAccountId } = createAccountListHelpers("zalo");
function resolveAccountConfig(cfg, accountId) {
  const accounts = cfg.channels?.zalo?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return void 0;
  }
  return accounts[accountId];
}
function mergeZaloAccountConfig(cfg, accountId) {
  const raw = cfg.channels?.zalo ?? {};
  const { accounts: _ignored, defaultAccount: _ignored2, ...base } = raw;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}
function resolveZaloAccount(params) {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.zalo?.enabled !== false;
  const merged = mergeZaloAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const tokenResolution = resolveZaloToken(
    params.cfg.channels?.zalo,
    accountId,
    { allowUnresolvedSecretRef: params.allowUnresolvedSecretRef }
  );
  return {
    accountId,
    name: merged.name?.trim() || void 0,
    enabled,
    token: tokenResolution.token,
    tokenSource: tokenResolution.source,
    config: merged
  };
}
function listEnabledZaloAccounts(cfg) {
  return listZaloAccountIds(cfg).map((accountId) => resolveZaloAccount({ cfg, accountId })).filter((account) => account.enabled);
}
export {
  listEnabledZaloAccounts,
  listZaloAccountIds,
  resolveDefaultZaloAccountId,
  resolveZaloAccount
};
