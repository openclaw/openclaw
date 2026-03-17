import { normalizeChatType } from "../../../src/channels/chat-type.js";
import { createAccountListHelpers } from "../../../src/channels/plugins/account-helpers.js";
import { resolveAccountEntry } from "../../../src/routing/account-lookup.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../src/routing/session-key.js";
import { resolveSlackAppToken, resolveSlackBotToken, resolveSlackUserToken } from "./token.js";
const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("slack");
const listSlackAccountIds = listAccountIds;
const resolveDefaultSlackAccountId = resolveDefaultAccountId;
function resolveAccountConfig(cfg, accountId) {
  return resolveAccountEntry(cfg.channels?.slack?.accounts, accountId);
}
function mergeSlackAccountConfig(cfg, accountId) {
  const { accounts: _ignored, ...base } = cfg.channels?.slack ?? {};
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}
function resolveSlackAccount(params) {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.slack?.enabled !== false;
  const merged = mergeSlackAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envBot = allowEnv ? resolveSlackBotToken(process.env.SLACK_BOT_TOKEN) : void 0;
  const envApp = allowEnv ? resolveSlackAppToken(process.env.SLACK_APP_TOKEN) : void 0;
  const envUser = allowEnv ? resolveSlackUserToken(process.env.SLACK_USER_TOKEN) : void 0;
  const configBot = resolveSlackBotToken(
    merged.botToken,
    `channels.slack.accounts.${accountId}.botToken`
  );
  const configApp = resolveSlackAppToken(
    merged.appToken,
    `channels.slack.accounts.${accountId}.appToken`
  );
  const configUser = resolveSlackUserToken(
    merged.userToken,
    `channels.slack.accounts.${accountId}.userToken`
  );
  const botToken = configBot ?? envBot;
  const appToken = configApp ?? envApp;
  const userToken = configUser ?? envUser;
  const botTokenSource = configBot ? "config" : envBot ? "env" : "none";
  const appTokenSource = configApp ? "config" : envApp ? "env" : "none";
  const userTokenSource = configUser ? "config" : envUser ? "env" : "none";
  return {
    accountId,
    enabled,
    name: merged.name?.trim() || void 0,
    botToken,
    appToken,
    userToken,
    botTokenSource,
    appTokenSource,
    userTokenSource,
    config: merged,
    groupPolicy: merged.groupPolicy,
    textChunkLimit: merged.textChunkLimit,
    mediaMaxMb: merged.mediaMaxMb,
    reactionNotifications: merged.reactionNotifications,
    reactionAllowlist: merged.reactionAllowlist,
    replyToMode: merged.replyToMode,
    replyToModeByChatType: merged.replyToModeByChatType,
    actions: merged.actions,
    slashCommand: merged.slashCommand,
    dm: merged.dm,
    channels: merged.channels
  };
}
function listEnabledSlackAccounts(cfg) {
  return listSlackAccountIds(cfg).map((accountId) => resolveSlackAccount({ cfg, accountId })).filter((account) => account.enabled);
}
function resolveSlackReplyToMode(account, chatType) {
  const normalized = normalizeChatType(chatType ?? void 0);
  if (normalized && account.replyToModeByChatType?.[normalized] !== void 0) {
    return account.replyToModeByChatType[normalized] ?? "off";
  }
  if (normalized === "direct" && account.dm?.replyToMode !== void 0) {
    return account.dm.replyToMode;
  }
  return account.replyToMode ?? "off";
}
export {
  listEnabledSlackAccounts,
  listSlackAccountIds,
  mergeSlackAccountConfig,
  resolveDefaultSlackAccountId,
  resolveSlackAccount,
  resolveSlackReplyToMode
};
