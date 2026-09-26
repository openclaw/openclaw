import {
  buildChannelGroupsScopeTree,
  resolveScopeRequireMention,
  resolveScopeToolsPolicy,
  type GroupToolPolicyConfig,
} from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

type IMessageGroupContext = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  groupId?: string | null;
  senderPolicyMode?: "always" | "never";
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
};

function resolveScopePath(params: IMessageGroupContext) {
  return params.groupId ? [params.groupId] : [];
}

export function resolveIMessageGroupRequireMention(params: IMessageGroupContext): boolean {
  return resolveScopeRequireMention({
    tree: buildChannelGroupsScopeTree(params.cfg, "imessage", params.accountId),
    path: resolveScopePath(params),
  });
}

export function resolveIMessageGroupToolPolicy(
  params: IMessageGroupContext,
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
