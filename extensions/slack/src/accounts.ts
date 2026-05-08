import {
  createAccountListHelpers,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  resolveMergedAccountConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import { coerceSecretRef } from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { SlackAccountSurfaceFields } from "./account-surface-fields.js";
import type { SlackAccountConfig } from "./runtime-api.js";
import { resolveSlackAppToken, resolveSlackBotToken, resolveSlackUserToken } from "./token.js";

export { resolveSlackReplyToMode } from "./account-reply-mode.js";

export type SlackTokenSource = "env" | "config" | "none";

type SlackTokenNormalizer = (raw?: unknown, path?: string) => string | undefined;

export type ResolvedSlackAccount = {
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

const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("slack");
export const listSlackAccountIds = listAccountIds;
export const resolveDefaultSlackAccountId = resolveDefaultAccountId;

function resolveSlackConfiguredTokenWithEnvFallback(params: {
  value?: unknown;
  path: string;
  envToken?: string;
  normalize: SlackTokenNormalizer;
  expectedEnvId: string;
}): { token?: string; source: SlackTokenSource } {
  const ref = coerceSecretRef(params.value);
  if (params.envToken && ref?.source === "env" && ref.id === params.expectedEnvId) {
    return {
      token: params.envToken,
      source: "env",
    };
  }
  const token = params.normalize(params.value, params.path);
  return {
    token,
    source: token ? "config" : "none",
  };
}

export function mergeSlackAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): SlackAccountConfig {
  return resolveMergedAccountConfig<SlackAccountConfig>({
    channelConfig: cfg.channels?.slack as SlackAccountConfig,
    accounts: cfg.channels?.slack?.accounts as Record<string, Partial<SlackAccountConfig>>,
    accountId,
  });
}

export function resolveSlackAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedSlackAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultSlackAccountId(params.cfg),
  );
  const baseEnabled = params.cfg.channels?.slack?.enabled !== false;
  const merged = mergeSlackAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const mode = merged.mode ?? "socket";
  const baseAllowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const botActive = enabled;
  const appActive = enabled && mode !== "http";
  const userActive = enabled;
  const envBot =
    botActive && baseAllowEnv ? resolveSlackBotToken(process.env.SLACK_BOT_TOKEN) : undefined;
  const envApp =
    appActive && baseAllowEnv ? resolveSlackAppToken(process.env.SLACK_APP_TOKEN) : undefined;
  const envUser =
    userActive && baseAllowEnv ? resolveSlackUserToken(process.env.SLACK_USER_TOKEN) : undefined;
  const configBot = botActive
    ? resolveSlackConfiguredTokenWithEnvFallback({
        value: merged.botToken,
        path: `channels.slack.accounts.${accountId}.botToken`,
        envToken: envBot,
        normalize: resolveSlackBotToken,
        expectedEnvId: "SLACK_BOT_TOKEN",
      })
    : { token: undefined, source: "none" as const };
  const configApp = appActive
    ? resolveSlackConfiguredTokenWithEnvFallback({
        value: merged.appToken,
        path: `channels.slack.accounts.${accountId}.appToken`,
        envToken: envApp,
        normalize: resolveSlackAppToken,
        expectedEnvId: "SLACK_APP_TOKEN",
      })
    : { token: undefined, source: "none" as const };
  const configUser = userActive
    ? resolveSlackConfiguredTokenWithEnvFallback({
        value: merged.userToken,
        path: `channels.slack.accounts.${accountId}.userToken`,
        envToken: envUser,
        normalize: resolveSlackUserToken,
        expectedEnvId: "SLACK_USER_TOKEN",
      })
    : { token: undefined, source: "none" as const };
  const botToken = configBot.token ?? envBot;
  const appToken = configApp.token ?? envApp;
  const userToken = configUser.token ?? envUser;
  const botTokenSource: SlackTokenSource =
    configBot.source !== "none" ? configBot.source : envBot ? "env" : "none";
  const appTokenSource: SlackTokenSource =
    configApp.source !== "none" ? configApp.source : envApp ? "env" : "none";
  const userTokenSource: SlackTokenSource =
    configUser.source !== "none" ? configUser.source : envUser ? "env" : "none";

  return {
    accountId,
    enabled,
    name: normalizeOptionalString(merged.name),
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
    channels: merged.channels,
  };
}

export function listEnabledSlackAccounts(cfg: OpenClawConfig): ResolvedSlackAccount[] {
  return listSlackAccountIds(cfg)
    .map((accountId) => resolveSlackAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
