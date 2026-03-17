import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { createAccountListHelpers } from "openclaw/plugin-sdk/bluebubbles";
import { hasConfiguredSecretInput, normalizeSecretInputString } from "./secret-input.js";
import { normalizeBlueBubblesServerUrl } from "./types.js";
const {
  listAccountIds: listBlueBubblesAccountIds,
  resolveDefaultAccountId: resolveDefaultBlueBubblesAccountId
} = createAccountListHelpers("bluebubbles");
function resolveAccountConfig(cfg, accountId) {
  const accounts = cfg.channels?.bluebubbles?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return void 0;
  }
  return accounts[accountId];
}
function mergeBlueBubblesAccountConfig(cfg, accountId) {
  const base = cfg.channels?.bluebubbles ?? {};
  const { accounts: _ignored, defaultAccount: _ignoredDefaultAccount, ...rest } = base;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  const chunkMode = account.chunkMode ?? rest.chunkMode ?? "length";
  return { ...rest, ...account, chunkMode };
}
function resolveBlueBubblesAccount(params) {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.bluebubbles?.enabled;
  const merged = mergeBlueBubblesAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const serverUrl = normalizeSecretInputString(merged.serverUrl);
  const password = normalizeSecretInputString(merged.password);
  const configured = Boolean(serverUrl && hasConfiguredSecretInput(merged.password));
  const baseUrl = serverUrl ? normalizeBlueBubblesServerUrl(serverUrl) : void 0;
  return {
    accountId,
    enabled: baseEnabled !== false && accountEnabled,
    name: merged.name?.trim() || void 0,
    config: merged,
    configured,
    baseUrl
  };
}
function listEnabledBlueBubblesAccounts(cfg) {
  return listBlueBubblesAccountIds(cfg).map((accountId) => resolveBlueBubblesAccount({ cfg, accountId })).filter((account) => account.enabled);
}
export {
  listBlueBubblesAccountIds,
  listEnabledBlueBubblesAccounts,
  resolveBlueBubblesAccount,
  resolveDefaultBlueBubblesAccountId
};
