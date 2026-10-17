import {
  createAccountListHelpers,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import {
  mapAllowFromEntries,
  normalizeChannelDmPolicy,
  type ChannelDmPolicy,
} from "openclaw/plugin-sdk/channel-config-helpers";
import type { SlackAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveAccountEntry } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { hasSlackAccountCredentialsFromConfig } from "./account-configured.js";
import {
  buildSlackAccountSurfaceFields,
  type SlackAccountSurfaceFields,
} from "./account-surface-fields.js";
import { resolveSlackAppToken, resolveSlackBotToken, resolveSlackUserToken } from "./token.js";

export { resolveSlackReplyToMode } from "./account-reply-mode.js";

export type SlackTokenSource = "env" | "config" | "none";

export type ResolvedSlackAccount = {
  accountId: string;
  enabled: boolean;
  identity: "bot" | "user";
  name?: string;
  botToken?: string;
  appToken?: string;
  userToken?: string;
  botTokenSource: SlackTokenSource;
  appTokenSource: SlackTokenSource;
  userTokenSource: SlackTokenSource;
  config: SlackAccountConfig;
} & SlackAccountSurfaceFields;

export type SlackConfigAccessorAccount = {
  allowFrom: string[] | undefined;
  defaultTo: string | undefined;
};

export function resolveSlackOperationToken(
  account: ResolvedSlackAccount,
  operation: "read" | "write",
): string | undefined {
  if (account.identity === "user") {
    // User identity acts as the authorizing human through the xoxp user token;
    // the companion Slack app carries events through the selected transport.
    return normalizeOptionalString(account.userToken);
  }
  const userToken = normalizeOptionalString(account.userToken);
  const botToken = normalizeOptionalString(account.botToken);
  if (operation === "read") {
    return userToken ?? botToken;
  }
  return account.config.userTokenReadOnly === false ? (botToken ?? userToken) : botToken;
}

export function hasImplicitDefaultSlackAccount(cfg: OpenClawConfig): boolean {
  return hasSlackAccountCredentialsFromConfig(cfg.channels?.slack, process.env);
}

const {
  listAccountIds,
  resolveDefaultAccountId,
  resolveAccountConfig: resolveMergedSlackAccountConfig,
} = createAccountListHelpers<SlackAccountConfig>("slack", {
  nestedObjectKeys: ["actions", "botLoopProtection", "presenceEvents", "relay"],
  hasImplicitDefaultAccount: hasImplicitDefaultSlackAccount,
});
export const listSlackAccountIds = listAccountIds;
export const resolveDefaultSlackAccountId = resolveDefaultAccountId;

function resolveSlackAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): SlackAccountConfig | undefined {
  return resolveAccountEntry(cfg.channels?.slack?.accounts, accountId);
}

type SlackStreamingConfig = NonNullable<SlackAccountConfig["streaming"]>;

function mergeSlackStreamingConfig(
  baseConfig: SlackStreamingConfig | undefined,
  accountConfig: SlackStreamingConfig | undefined,
): SlackStreamingConfig | undefined {
  if (!baseConfig || !accountConfig) {
    return accountConfig ?? baseConfig;
  }
  const merged = { ...baseConfig, ...accountConfig };
  for (const key of ["preview", "progress", "block"] as const) {
    if (baseConfig[key] || accountConfig[key]) {
      merged[key] = { ...baseConfig[key], ...accountConfig[key] };
    }
  }
  const baseCoalesce = baseConfig.block?.coalesce;
  const accountCoalesce = accountConfig.block?.coalesce;
  if (merged.block && (baseCoalesce || accountCoalesce)) {
    merged.block.coalesce = { ...baseCoalesce, ...accountCoalesce };
  }
  return merged;
}

export function mergeSlackAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): SlackAccountConfig {
  const accountConfig = resolveSlackAccountConfig(cfg, accountId);
  const merged = resolveMergedSlackAccountConfig(cfg, accountId);
  const streaming = mergeSlackStreamingConfig(
    cfg.channels?.slack?.streaming,
    accountConfig?.streaming,
  );
  return streaming !== undefined ? { ...merged, streaming } : merged;
}

export function resolveSlackAccountAllowFrom(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] | undefined {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultSlackAccountId(params.cfg),
  );
  const accountConfig = resolveSlackAccountConfig(params.cfg, accountId);
  const rootConfig = params.cfg.channels?.slack as SlackAccountConfig | undefined;
  const allowFrom = accountConfig?.allowFrom ?? rootConfig?.allowFrom;
  return allowFrom ? mapAllowFromEntries(allowFrom) : undefined;
}

export function resolveSlackConfigAccessorAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): SlackConfigAccessorAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultSlackAccountId(params.cfg),
  );
  const config = mergeSlackAccountConfig(params.cfg, accountId);
  return {
    allowFrom: resolveSlackAccountAllowFrom({ cfg: params.cfg, accountId }),
    defaultTo: config.defaultTo,
  };
}

export function resolveSlackAccountDmPolicy(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ChannelDmPolicy | undefined {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultSlackAccountId(params.cfg),
  );
  const accountConfig = resolveSlackAccountConfig(params.cfg, accountId);
  const rootConfig = params.cfg.channels?.slack as SlackAccountConfig | undefined;
  return normalizeChannelDmPolicy(accountConfig?.dmPolicy ?? rootConfig?.dmPolicy ?? "pairing");
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
  const identity = merged.postAs ?? "bot";
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const mode = merged.mode ?? "socket";
  const baseAllowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const botActive = enabled;
  const appActive = enabled && mode === "socket";
  const userActive = enabled;
  const envBot =
    botActive && baseAllowEnv ? resolveSlackBotToken(process.env.SLACK_BOT_TOKEN) : undefined;
  const envApp =
    appActive && baseAllowEnv ? resolveSlackAppToken(process.env.SLACK_APP_TOKEN) : undefined;
  const envUser =
    userActive && baseAllowEnv ? resolveSlackUserToken(process.env.SLACK_USER_TOKEN) : undefined;
  const configBot = botActive
    ? resolveSlackBotToken(merged.botToken, `channels.slack.accounts.${accountId}.botToken`)
    : undefined;
  const configApp = appActive
    ? resolveSlackAppToken(merged.appToken, `channels.slack.accounts.${accountId}.appToken`)
    : undefined;
  const configUser = userActive
    ? resolveSlackUserToken(merged.userToken, `channels.slack.accounts.${accountId}.userToken`)
    : undefined;
  const botToken = configBot ?? envBot;
  const appToken = configApp ?? envApp;
  const userToken = configUser ?? envUser;
  const botTokenSource: SlackTokenSource = configBot ? "config" : envBot ? "env" : "none";
  const appTokenSource: SlackTokenSource = configApp ? "config" : envApp ? "env" : "none";
  const userTokenSource: SlackTokenSource = configUser ? "config" : envUser ? "env" : "none";

  return {
    accountId,
    enabled,
    identity,
    name: normalizeOptionalString(merged.name),
    botToken,
    appToken,
    userToken,
    botTokenSource,
    appTokenSource,
    userTokenSource,
    config: merged,
    ...buildSlackAccountSurfaceFields(merged),
  };
}

export function listEnabledSlackAccounts(cfg: OpenClawConfig): ResolvedSlackAccount[] {
  return listSlackAccountIds(cfg)
    .map((accountId) => resolveSlackAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
