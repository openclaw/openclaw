// Slack plugin module implements group policy behavior.
import { normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
import type { ChannelGroupContext } from "openclaw/plugin-sdk/channel-contract";
import {
  resolveScopeRequireMention,
  resolveScopeToolsPolicy,
  type GroupToolPolicyBySenderConfig,
  type GroupToolPolicyConfig,
  type ScopeTree,
} from "openclaw/plugin-sdk/channel-policy";
import { normalizeHyphenSlug } from "openclaw/plugin-sdk/string-normalization-runtime";
import { mergeSlackAccountConfig, resolveDefaultSlackAccountId } from "./accounts.js";

type SlackChannelPolicyEntry = {
  requireMention?: boolean;
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
};

function resolveSlackChannelPolicyScope(params: ChannelGroupContext) {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultSlackAccountId(params.cfg),
  );
  const channels = mergeSlackAccountConfig(params.cfg, accountId).channels as
    | Record<string, SlackChannelPolicyEntry>
    | undefined;
  // Whole-entry selection: an exact channel hides every wildcard field.
  // The wildcard is a normal scope selected only after all candidates miss.
  const tree: ScopeTree = { scopes: channels ?? {} };
  const channelId = params.groupId?.trim();
  const channelName = params.groupChannel?.replace(/^#/, "");
  const candidates = [
    channelId,
    channelName ? `#${channelName}` : undefined,
    channelName,
    normalizeHyphenSlug(channelName),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const key =
    candidates.find((candidate) => Object.hasOwn(tree.scopes, candidate)) ??
    (Object.hasOwn(tree.scopes, "*") ? "*" : undefined);
  return { tree, path: key ? [key] : [] };
}

export function resolveSlackGroupRequireMention(params: ChannelGroupContext): boolean {
  // The adapter intentionally ignores root requireMention; the monitor resolves that default.
  return resolveScopeRequireMention(resolveSlackChannelPolicyScope(params));
}

export function resolveSlackGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const scope = resolveSlackChannelPolicyScope(params);
  // No messageProvider: this path historically never matched channel-prefixed sender keys.
  return resolveScopeToolsPolicy({
    ...scope,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
}
