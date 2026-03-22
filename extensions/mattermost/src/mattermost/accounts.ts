import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  resolveAccountEntry,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-resolution";
import { createAccountListHelpers, type OpenClawConfig } from "../runtime-api.js";
import { normalizeResolvedSecretInputString, normalizeSecretInputString } from "../secret-input.js";
import type {
  MattermostAccountConfig,
  MattermostChatMode,
  MattermostChatTypeKey,
  MattermostReplyToMode,
} from "../types.js";
import { normalizeMattermostBaseUrl } from "./client.js";

export type MattermostTokenSource = "env" | "config" | "none";
export type MattermostBaseUrlSource = "env" | "config" | "none";

export type ResolvedMattermostAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  botToken?: string;
  baseUrl?: string;
  botTokenSource: MattermostTokenSource;
  baseUrlSource: MattermostBaseUrlSource;
  config: MattermostAccountConfig;
  chatmode?: MattermostChatMode;
  oncharPrefixes?: string[];
  requireMention?: boolean;
  textChunkLimit?: number;
  blockStreaming?: boolean;
  blockStreamingCoalesce?: MattermostAccountConfig["blockStreamingCoalesce"];
};

const {
  listAccountIds: listMattermostAccountIds,
  resolveDefaultAccountId: resolveDefaultMattermostAccountId,
} = createAccountListHelpers("mattermost");
export { listMattermostAccountIds, resolveDefaultMattermostAccountId };

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): MattermostAccountConfig | undefined {
  return resolveAccountEntry(cfg.channels?.mattermost?.accounts, accountId);
}

function mergeMattermostAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): MattermostAccountConfig {
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  const merged = resolveMergedAccountConfig<MattermostAccountConfig>({
    channelConfig: cfg.channels?.mattermost as MattermostAccountConfig | undefined,
    accounts: cfg.channels?.mattermost?.accounts as
      | Record<string, Partial<MattermostAccountConfig>>
      | undefined,
    accountId,
    omitKeys: ["defaultAccount"],
  });

  // Shallow merging is fine for most keys, but `commands` should be merged
  // so that account-specific overrides (callbackPath/callbackUrl) do not
  // accidentally reset global settings like `native: true`.
  const mergedCommands = {
    ...((cfg.channels?.mattermost as MattermostAccountConfig | undefined)?.commands ?? {}),
    ...(account.commands ?? {}),
  };
  if (Object.keys(mergedCommands).length > 0) {
    merged.commands = mergedCommands;
  }

  return merged;
}

function resolveMattermostRequireMention(config: MattermostAccountConfig): boolean | undefined {
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

export function resolveMattermostAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  allowUnresolvedSecretRef?: boolean;
}): ResolvedMattermostAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.mattermost?.enabled !== false;
  const merged = mergeMattermostAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envToken = allowEnv ? process.env.MATTERMOST_BOT_TOKEN?.trim() : undefined;
  const envUrl = allowEnv ? process.env.MATTERMOST_URL?.trim() : undefined;
  const configToken = params.allowUnresolvedSecretRef
    ? normalizeSecretInputString(merged.botToken)
    : normalizeResolvedSecretInputString({
        value: merged.botToken,
        path: `channels.mattermost.accounts.${accountId}.botToken`,
      });
  const configUrl = merged.baseUrl?.trim();
  const botToken = configToken || envToken;
  const baseUrl = normalizeMattermostBaseUrl(configUrl || envUrl);
  const requireMention = resolveMattermostRequireMention(merged);

  const botTokenSource: MattermostTokenSource = configToken ? "config" : envToken ? "env" : "none";
  const baseUrlSource: MattermostBaseUrlSource = configUrl ? "config" : envUrl ? "env" : "none";

  return {
    accountId,
    enabled,
    name: merged.name?.trim() || undefined,
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
    blockStreamingCoalesce: merged.blockStreamingCoalesce,
  };
}

/**
 * Resolve the effective replyToMode for a given chat type.
 * Mattermost auto-threading only applies to channel and group messages.
 */
export function resolveMattermostReplyToMode(
  account: ResolvedMattermostAccount,
  kind: MattermostChatTypeKey,
): MattermostReplyToMode {
  if (kind === "direct") {
    return "off";
  }
  return account.config.replyToMode ?? "off";
}

export function listEnabledMattermostAccounts(cfg: OpenClawConfig): ResolvedMattermostAccount[] {
  return listMattermostAccountIds(cfg)
    .map((accountId) => resolveMattermostAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
