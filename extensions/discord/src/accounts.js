import { createAccountActionGate } from "../../../src/channels/plugins/account-action-gate.js";
import { createAccountListHelpers } from "../../../src/channels/plugins/account-helpers.js";
import { resolveAccountEntry } from "../../../src/routing/account-lookup.js";
import { normalizeAccountId } from "../../../src/routing/session-key.js";
import { resolveDiscordToken } from "./token.js";
const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("discord");
const listDiscordAccountIds = listAccountIds;
const resolveDefaultDiscordAccountId = resolveDefaultAccountId;
function resolveDiscordAccountConfig(cfg, accountId) {
  return resolveAccountEntry(cfg.channels?.discord?.accounts, accountId);
}
function mergeDiscordAccountConfig(cfg, accountId) {
  const { accounts: _ignored, ...base } = cfg.channels?.discord ?? {};
  const account = resolveDiscordAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}
function createDiscordActionGate(params) {
  const accountId = normalizeAccountId(params.accountId);
  return createAccountActionGate({
    baseActions: params.cfg.channels?.discord?.actions,
    accountActions: resolveDiscordAccountConfig(params.cfg, accountId)?.actions
  });
}
function resolveDiscordAccount(params) {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.discord?.enabled !== false;
  const merged = mergeDiscordAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const tokenResolution = resolveDiscordToken(params.cfg, { accountId });
  return {
    accountId,
    enabled,
    name: merged.name?.trim() || void 0,
    token: tokenResolution.token,
    tokenSource: tokenResolution.source,
    config: merged
  };
}
function resolveDiscordMaxLinesPerMessage(params) {
  if (typeof params.discordConfig?.maxLinesPerMessage === "number") {
    return params.discordConfig.maxLinesPerMessage;
  }
  return resolveDiscordAccount({
    cfg: params.cfg,
    accountId: params.accountId
  }).config.maxLinesPerMessage;
}
function listEnabledDiscordAccounts(cfg) {
  return listDiscordAccountIds(cfg).map((accountId) => resolveDiscordAccount({ cfg, accountId })).filter((account) => account.enabled);
}
export {
  createDiscordActionGate,
  listDiscordAccountIds,
  listEnabledDiscordAccounts,
  mergeDiscordAccountConfig,
  resolveDefaultDiscordAccountId,
  resolveDiscordAccount,
  resolveDiscordAccountConfig,
  resolveDiscordMaxLinesPerMessage
};
