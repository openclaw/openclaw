import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { createAccountListHelpers } from "openclaw/plugin-sdk/matrix";
import { hasConfiguredSecretInput } from "../secret-input.js";
import { resolveMatrixConfigForAccount } from "./client.js";
import { credentialsMatchConfig, loadMatrixCredentials } from "./credentials.js";
function mergeAccountConfig(base, account) {
  const merged = { ...base, ...account };
  for (const key of ["dm", "actions"]) {
    const b = base[key];
    const o = account[key];
    if (typeof b === "object" && b != null && typeof o === "object" && o != null) {
      merged[key] = { ...b, ...o };
    }
  }
  delete merged.accounts;
  delete merged.defaultAccount;
  return merged;
}
const {
  listAccountIds: listMatrixAccountIds,
  resolveDefaultAccountId: resolveDefaultMatrixAccountId
} = createAccountListHelpers("matrix", { normalizeAccountId });
function resolveAccountConfig(cfg, accountId) {
  const accounts = cfg.channels?.matrix?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return void 0;
  }
  if (accounts[accountId]) {
    return accounts[accountId];
  }
  const normalized = normalizeAccountId(accountId);
  for (const key of Object.keys(accounts)) {
    if (normalizeAccountId(key) === normalized) {
      return accounts[key];
    }
  }
  return void 0;
}
function resolveMatrixAccount(params) {
  const accountId = normalizeAccountId(params.accountId);
  const matrixBase = params.cfg.channels?.matrix ?? {};
  const base = resolveMatrixAccountConfig({ cfg: params.cfg, accountId });
  const enabled = base.enabled !== false && matrixBase.enabled !== false;
  const resolved = resolveMatrixConfigForAccount(params.cfg, accountId, process.env);
  const hasHomeserver = Boolean(resolved.homeserver);
  const hasUserId = Boolean(resolved.userId);
  const hasAccessToken = Boolean(resolved.accessToken);
  const hasPassword = Boolean(resolved.password);
  const hasPasswordAuth = hasUserId && (hasPassword || hasConfiguredSecretInput(base.password));
  const stored = loadMatrixCredentials(process.env, accountId);
  const hasStored = stored && resolved.homeserver ? credentialsMatchConfig(stored, {
    homeserver: resolved.homeserver,
    userId: resolved.userId || ""
  }) : false;
  const configured = hasHomeserver && (hasAccessToken || hasPasswordAuth || Boolean(hasStored));
  return {
    accountId,
    enabled,
    name: base.name?.trim() || void 0,
    configured,
    homeserver: resolved.homeserver || void 0,
    userId: resolved.userId || void 0,
    config: base
  };
}
function resolveMatrixAccountConfig(params) {
  const accountId = normalizeAccountId(params.accountId);
  const matrixBase = params.cfg.channels?.matrix ?? {};
  const accountConfig = resolveAccountConfig(params.cfg, accountId);
  if (!accountConfig) {
    return matrixBase;
  }
  return mergeAccountConfig(matrixBase, accountConfig);
}
function listEnabledMatrixAccounts(cfg) {
  return listMatrixAccountIds(cfg).map((accountId) => resolveMatrixAccount({ cfg, accountId })).filter((account) => account.enabled);
}
export {
  listEnabledMatrixAccounts,
  listMatrixAccountIds,
  resolveDefaultMatrixAccountId,
  resolveMatrixAccount,
  resolveMatrixAccountConfig
};
