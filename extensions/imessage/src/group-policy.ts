import type { ChannelGroupContext } from "openclaw/plugin-sdk/channel-contract";
import {
  buildChannelGroupsScopeTree,
  resolveScopeRequireMention,
  resolveScopeToolsPolicy,
  type GroupToolPolicyConfig,
} from "openclaw/plugin-sdk/channel-policy";

function resolveScopePath(params: ChannelGroupContext) {
  return params.groupId ? [params.groupId] : [];
}

export function resolveIMessageGroupRequireMention(params: ChannelGroupContext): boolean {
  return resolveScopeRequireMention({
    tree: buildChannelGroupsScopeTree(params.cfg, "imessage", params.accountId),
    path: resolveScopePath(params),
  });
}

export function resolveIMessageGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  return resolveScopeToolsPolicy({
    ...params,
    tree: buildChannelGroupsScopeTree(params.cfg, "imessage", params.accountId),
    path: resolveScopePath(params),
    messageProvider: "imessage",
  });
}

// An explicitly empty group prompt suppresses the wildcard instead of inheriting it.
export function resolveIMessageGroupSystemPrompt(params: {
  groupConfig?: Readonly<Record<string, unknown>>;
  defaultConfig?: Readonly<Record<string, unknown>>;
}): string | undefined {
  const prompt = params.groupConfig?.systemPrompt ?? params.defaultConfig?.systemPrompt;
  return typeof prompt === "string" ? prompt.trim() || undefined : undefined;
}
