import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { createAccountListHelpers } from "openclaw/plugin-sdk/mattermost";
import { normalizeResolvedSecretInputString, normalizeSecretInputString } from "../secret-input.js";
import { normalizeMattermostBaseUrl } from "./client.js";
const {
  listAccountIds: listMattermostAccountIds,
  resolveDefaultAccountId: resolveDefaultMattermostAccountId
} = createAccountListHelpers("mattermost");
function resolveAccountConfig(cfg, accountId) {
  const accounts = cfg.channels?.mattermost?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return void 0;
  }
  return accounts[accountId];
}
function mergeMattermostAccountConfig(cfg, accountId) {
  const {
    accounts: _ignored,
    defaultAccount: _ignoredDefaultAccount,
    ...base
  } = cfg.channels?.mattermost ?? {};
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  const mergedCommands = {
    ...base.commands ?? {},
    ...account.commands ?? {}
  };
  const merged = { ...base, ...account };
  if (Object.keys(mergedCommands).length > 0) {
    merged.commands = mergedCommands;
  }
  return merged;
}
function resolveMattermostRequireMention(config) {
  if (config.chatmode === "oncall") {
    return true;
  }
  if (config.chatmode === "onmessage") {
    return false;
  }
  if (config.chatmode === "onchar") {
    return true;
  }
  return config.requireMention;
}
function resolveMattermostAccount(params) {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.mattermost?.enabled !== false;
  const merged = mergeMattermostAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envToken = allowEnv ? process.env.MATTERMOST_BOT_TOKEN?.trim() : void 0;
  const envUrl = allowEnv ? process.env.MATTERMOST_URL?.trim() : void 0;
  const configToken = params.allowUnresolvedSecretRef ? normalizeSecretInputString(merged.botToken) : normalizeResolvedSecretInputString({
    value: merged.botToken,
    path: `channels.mattermost.accounts.${accountId}.botToken`
  });
  const configUrl = merged.baseUrl?.trim();
  const botToken = configToken || envToken;
  const baseUrl = normalizeMattermostBaseUrl(configUrl || envUrl);
  const requireMention = resolveMattermostRequireMention(merged);
  const botTokenSource = configToken ? "config" : envToken ? "env" : "none";
  const baseUrlSource = configUrl ? "config" : envUrl ? "env" : "none";
  return {
    accountId,
    enabled,
    name: merged.name?.trim() || void 0,
    botToken,
    baseUrl,
    botTokenSource,
    baseUrlSource,
    config: merged,
    chatmode: merged.chatmode,
    oncharPrefixes: merged.oncharPrefixes,
    requireMention,
    textChunkLimit: merged.textChunkLimit,
    blockStreaming: merged.blockStreaming,
    blockStreamingCoalesce: merged.blockStreamingCoalesce
  };
}
function resolveMattermostReplyToMode(account, kind) {
  if (kind === "direct") {
    return "off";
  }
  return account.config.replyToMode ?? "off";
}
function listEnabledMattermostAccounts(cfg) {
  return listMattermostAccountIds(cfg).map((accountId) => resolveMattermostAccount({ cfg, accountId })).filter((account) => account.enabled);
}
export {
  listEnabledMattermostAccounts,
  listMattermostAccountIds,
  resolveDefaultMattermostAccountId,
  resolveMattermostAccount,
  resolveMattermostReplyToMode
};
