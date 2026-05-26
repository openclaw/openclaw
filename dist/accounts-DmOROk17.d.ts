import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { N as SlackAccountConfig } from "./types.channels-qd_8k3sY.js";
//#region extensions/slack/src/account-surface-fields.d.ts
type SlackAccountSurfaceFields = {
  groupPolicy?: SlackAccountConfig["groupPolicy"];
  textChunkLimit?: SlackAccountConfig["textChunkLimit"];
  mediaMaxMb?: SlackAccountConfig["mediaMaxMb"];
  reactionNotifications?: SlackAccountConfig["reactionNotifications"];
  reactionAllowlist?: SlackAccountConfig["reactionAllowlist"];
  replyToMode?: SlackAccountConfig["replyToMode"];
  replyToModeByChatType?: SlackAccountConfig["replyToModeByChatType"];
  actions?: SlackAccountConfig["actions"];
  slashCommand?: SlackAccountConfig["slashCommand"];
  dm?: SlackAccountConfig["dm"];
  channels?: SlackAccountConfig["channels"];
};
//#endregion
//#region extensions/slack/src/account-reply-mode.d.ts
type SlackReplyToMode = "off" | "first" | "all" | "batched";
type SlackReplyToModeAccount = {
  replyToMode?: SlackReplyToMode;
  replyToModeByChatType?: SlackAccountConfig["replyToModeByChatType"];
  dm?: {
    replyToMode?: SlackReplyToMode;
  };
};
declare function resolveSlackReplyToMode(account: SlackReplyToModeAccount, chatType?: string | null): SlackReplyToMode;
//#endregion
//#region extensions/slack/src/accounts.d.ts
type SlackTokenSource = "env" | "config" | "none";
type ResolvedSlackAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  botToken?: string;
  appToken?: string;
  userToken?: string;
  botTokenSource: SlackTokenSource;
  appTokenSource: SlackTokenSource;
  userTokenSource: SlackTokenSource;
  config: SlackAccountConfig;
} & SlackAccountSurfaceFields;
declare const listSlackAccountIds: (cfg: OpenClawConfig) => string[];
declare const resolveDefaultSlackAccountId: (cfg: OpenClawConfig) => string;
declare function mergeSlackAccountConfig(cfg: OpenClawConfig, accountId: string): SlackAccountConfig;
declare function resolveSlackAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedSlackAccount;
declare function listEnabledSlackAccounts(cfg: OpenClawConfig): ResolvedSlackAccount[];
//#endregion
export { mergeSlackAccountConfig as a, resolveSlackReplyToMode as c, listSlackAccountIds as i, SlackAccountSurfaceFields as l, SlackTokenSource as n, resolveDefaultSlackAccountId as o, listEnabledSlackAccounts as r, resolveSlackAccount as s, ResolvedSlackAccount as t };