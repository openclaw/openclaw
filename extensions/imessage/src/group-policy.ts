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

/**
 * Per-group `systemPrompt` resolution. Mirrors `resolveWhatsAppGroupSystemPrompt`
 * in `extensions/whatsapp/src/system-prompt.ts`:
 *
 * 1. If the matched per-`chat_id` entry exists AND defines `systemPrompt` (key
 *    is present, value is non-null), use it. Trim whitespace; if the trim
 *    leaves an empty string, return `undefined` and DO NOT fall through to the
 *    wildcard. This is how operators say "this specific group has no prompt"
 *    without inheriting from `groups["*"]`.
 * 2. Otherwise, return the wildcard `groups["*"].systemPrompt` (trimmed; empty
 *    after trim → `undefined`).
 */
export function resolveIMessageGroupSystemPrompt(params: {
  groupConfig?: Readonly<Record<string, unknown>>;
  defaultConfig?: Readonly<Record<string, unknown>>;
}): string | undefined {
  const prompt = params.groupConfig?.systemPrompt ?? params.defaultConfig?.systemPrompt;
  return typeof prompt === "string" ? prompt.trim() || undefined : undefined;
}
