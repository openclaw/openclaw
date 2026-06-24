// Mattermost plugin module implements a process-wide best-effort cache of
// channel id -> chat type, fed by the monitor's already-resolved channel
// info so the synchronous `inferTargetChatType` outbound hook can answer
// without a network round trip (#95646).
import type { ChatType } from "./runtime-api.js";

/** Maximum number of channel-kind entries kept in the process-wide cache. */
const MAX_CHANNEL_KIND_CACHE_SIZE = 2_000;

/** TTL in ms — entries older than this are treated as expired and re-classified. */
const CHANNEL_KIND_CACHE_TTL_MS = 30 * 60 * 1_000; // 30 minutes

interface CachedKindEntry {
  kind: ChatType;
  expiresAt: number;
}

const channelKinds = new Map<string, CachedKindEntry>();

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
  channelKinds.set(trimmed, { kind, expiresAt: Date.now() + CHANNEL_KIND_CACHE_TTL_MS });
}

/** Returns the last known chat type for a Mattermost channel id, if seen and not expired. */
export function peekMattermostChannelKind(channelId: string): ChatType | undefined {
  const trimmed = channelId.trim();
  const entry = channelKinds.get(trimmed);
  if (!entry) {
    return undefined;
  }
  if (Date.now() > entry.expiresAt) {
    channelKinds.delete(trimmed);
    return undefined;
  }
  return entry.kind;
}
