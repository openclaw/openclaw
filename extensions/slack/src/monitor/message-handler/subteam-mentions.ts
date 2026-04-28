import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

const SUBTEAM_TOKEN_RE = /<!subteam\^([A-Z0-9]+)(?:\|[^>]*)?>/g;

/**
 * Extracts Slack subteam (user-group) IDs referenced in `<!subteam^SXXX>`
 * tokens within a message body. Returns an array of unique uppercase IDs.
 */
export function extractSlackSubteamMentionIds(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(SUBTEAM_TOKEN_RE)) {
    const id = m[1]?.toUpperCase();
    if (id) out.add(id);
  }
  return [...out];
}

function normalizeSubteamIdList(list: readonly string[] | undefined): string[] {
  if (!list || list.length === 0) return [];
  const out: string[] = [];
  for (const raw of list) {
    const v = normalizeOptionalString(raw);
    if (v) out.push(v.toUpperCase());
  }
  return out;
}

function resolveConfiguredSubteamIds(
  cfg: OpenClawConfig | undefined,
  agentId: string | undefined,
): string[] {
  if (!cfg) return [];
  const agentGroupChat = agentId ? resolveAgentConfig(cfg, agentId)?.groupChat : undefined;
  // Mirror `mentionPatterns` semantics: presence (even empty) is an explicit
  // override that shadows the global list.
  if (agentGroupChat && Object.hasOwn(agentGroupChat, "subteamMentions")) {
    return normalizeSubteamIdList(agentGroupChat.subteamMentions);
  }
  return normalizeSubteamIdList(cfg.messages?.groupChat?.subteamMentions);
}

/**
 * Returns true if any subteam ID extracted from message text matches one
 * configured for the given agent (or the global fallback).
 */
export function matchesConfiguredSubteamMention(
  messageSubteamIds: readonly string[],
  cfg: OpenClawConfig | undefined,
  agentId: string | undefined,
): boolean {
  if (messageSubteamIds.length === 0) return false;
  const configured = resolveConfiguredSubteamIds(cfg, agentId);
  if (configured.length === 0) return false;
  const set = new Set(configured);
  return messageSubteamIds.some((id) => set.has(id.toUpperCase()));
}
