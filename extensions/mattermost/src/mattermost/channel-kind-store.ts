// Mattermost plugin module implements a process-wide best-effort cache of
// channel id -> chat type, fed by the monitor's already-resolved channel
// info so the synchronous `inferTargetChatType` outbound hook can answer
// without a network round trip (#95646).
import type { ChatType } from "./runtime-api.js";

/** Maximum number of channel-kind entries kept in the process-wide cache. */
const MAX_CHANNEL_KIND_CACHE_SIZE = 2_000;

const channelKinds = new Map<string, ChatType>();

/** Records the last known chat type for a Mattermost channel id. */
export function rememberMattermostChannelKind(channelId: string, kind: ChatType): void {
  const trimmed = channelId.trim();
  if (!trimmed) {
    return;
  }
  if (channelKinds.size >= MAX_CHANNEL_KIND_CACHE_SIZE) {
    // Evict the oldest entry (Map preserves insertion order).
    const oldest = channelKinds.keys().next().value;
    if (oldest !== undefined) {
      channelKinds.delete(oldest);
    }
  }
  channelKinds.set(trimmed, kind);
}

/** Returns the last known chat type for a Mattermost channel id, if seen before. */
export function peekMattermostChannelKind(channelId: string): ChatType | undefined {
  return channelKinds.get(channelId.trim());
}
