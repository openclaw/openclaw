// Mattermost plugin module implements chat-type cache behavior.
import { mapMattermostChannelTypeToChatType } from "./monitor-gating.js";
import type { ChatType } from "./runtime-api.js";

/** Mattermost IDs are 26-character lowercase alphanumeric strings. */
export function isMattermostId(value: string): boolean {
  return /^[a-z0-9]{26}$/.test(value);
}

// Id-keyed chat-type cache for the sync `inferTargetChatType` hook. That hook only
// receives `{ to }` (no account/baseUrl), so it cannot key the per-account resolution
// cache in target-resolution; this map lets outbound resolution and inbound monitor
// reads share the authoritative channel type. Mattermost channel ids are server-unique
// 26-char strings, so id-only keying is safe in practice. Kept as a leaf module (no
// client/runtime deps) so `channel.ts` can import the sync hook without pulling the lazy
// `channel.runtime` chunk eager.
const chatTypeByChannelId = new Map<string, ChatType>();

/** Records an authoritative channel type so the sync `inferTargetChatType` hook can read it. */
export function recordMattermostChannelChatType(
  channelId: string,
  channelType?: string | null,
): void {
  const id = channelId.trim();
  if (!isMattermostId(id) || !channelType) {
    return;
  }
  chatTypeByChannelId.set(id, mapMattermostChannelTypeToChatType(channelType));
}

// Sync hook for core target -> chat-type inference. Returns a definitive type only when
// the channel type is already known (resolved outbound or seen inbound); otherwise core
// keeps its generic `channel:` default. A private channel (`P`/`G`) addressed as
// `channel:<id>` resolves to `group`, which keeps it in one session namespace.
export function inferMattermostTargetChatType(to: string): ChatType | undefined {
  const trimmed = to.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("user:") || lower.startsWith("mattermost:")) {
    return "direct";
  }
  if (lower.startsWith("group:")) {
    return "group";
  }
  const id = lower.startsWith("channel:") ? trimmed.slice("channel:".length).trim() : trimmed;
  if (!isMattermostId(id)) {
    return undefined;
  }
  return chatTypeByChannelId.get(id);
}

export function resetMattermostChatTypeCacheForTests(): void {
  chatTypeByChannelId.clear();
}
