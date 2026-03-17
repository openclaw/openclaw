import { createAccountListHelpers } from "../../../src/channels/plugins/account-helpers.js";
import { resolveAccountEntry } from "../../../src/routing/account-lookup.js";
import { normalizeAccountId } from "../../../src/routing/session-key.js";
const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("signal");
const listSignalAccountIds = listAccountIds;
const resolveDefaultSignalAccountId = resolveDefaultAccountId;
function resolveAccountConfig(cfg, accountId) {
  return resolveAccountEntry(cfg.channels?.signal?.accounts, accountId);
}
function mergeSignalAccountConfig(cfg, accountId) {
  const { accounts: _ignored, ...base } = cfg.channels?.signal ?? {};
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}
function resolveSignalAccount(params) {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.signal?.enabled !== false;
  const merged = mergeSignalAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const host = merged.httpHost?.trim() || "127.0.0.1";
  const port = merged.httpPort ?? 8080;
  const baseUrl = merged.httpUrl?.trim() || `http://${host}:${port}`;
  const configured = Boolean(
    merged.account?.trim() || merged.httpUrl?.trim() || merged.cliPath?.trim() || merged.httpHost?.trim() || typeof merged.httpPort === "number" || typeof merged.autoStart === "boolean"
  );
  return {
    accountId,
    enabled,
    name: merged.name?.trim() || void 0,
    baseUrl,
    configured,
    config: merged
  };
}
function listEnabledSignalAccounts(cfg) {
  return listSignalAccountIds(cfg).map((accountId) => resolveSignalAccount({ cfg, accountId })).filter((account) => account.enabled);
}
export {
  listEnabledSignalAccounts,
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount
};
