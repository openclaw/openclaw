/**
 * In-memory component registry with TTL.
 * Mirrors src/discord/components-registry.ts for the Zulip channel.
 */

export type ZulipComponentEntry = {
  /** Unique button ID (e.g. "btn_abc123") */
  id: string;
  /** Human-readable label */
  label: string;
  /** Button style hint */
  style: string;
  /** Session key for routing the callback */
  sessionKey: string;
  /** Agent ID that owns this component */
  agentId: string;
  /** Zulip account ID */
  accountId: string;
  /** Optional logical callback payload */
  callbackData?: string;
  /** Zulip message ID the widget was attached to */
  messageId?: number;
  /** Canonical Zulip target for follow-up replies (stream/topic or dm ids). */
  replyTo?: string;
  /** Chat type for the originating widget conversation. */
  chatType?: "channel" | "direct";
  /** If true, entry is not consumed on resolve (reusable button) */
  reusable?: boolean;
  /** Restrict to specific Zulip user IDs */
  allowedUsers?: number[];
  createdAt?: number;
  expiresAt?: number;
};

const DEFAULT_COMPONENT_TTL_MS = 30 * 60 * 1000; // 30 minutes

const componentEntries = new Map<string, ZulipComponentEntry>();

function isExpired(entry: { expiresAt?: number }, now: number): boolean {
  return typeof entry.expiresAt === "number" && entry.expiresAt <= now;
}

function normalizeEntryTimestamps<T extends { createdAt?: number; expiresAt?: number }>(
  entry: T,
  now: number,
  ttlMs: number,
): T {
  const createdAt = entry.createdAt ?? now;
  const expiresAt = entry.expiresAt ?? createdAt + ttlMs;
  return { ...entry, createdAt, expiresAt };
}

export function registerZulipComponentEntries(params: {
  entries: ZulipComponentEntry[];
  ttlMs?: number;
  messageId?: number;
}): void {
  const now = Date.now();
  const ttlMs = params.ttlMs ?? DEFAULT_COMPONENT_TTL_MS;
  for (const entry of params.entries) {
    const normalized = normalizeEntryTimestamps(
      { ...entry, messageId: params.messageId ?? entry.messageId },
      now,
      ttlMs,
    );
    componentEntries.set(entry.id, normalized);
  }
}

export function resolveZulipComponentEntry(params: {
  id: string;
  consume?: boolean;
}): ZulipComponentEntry | null {
  const entry = componentEntries.get(params.id);
  if (!entry) {
    return null;
  }
  const now = Date.now();
  if (isExpired(entry, now)) {
    componentEntries.delete(params.id);
    return null;
  }
  if (params.consume !== false) {
    componentEntries.delete(params.id);
  }
  return entry;
}

export function removeZulipComponentEntry(id: string): void {
  componentEntries.delete(id);
}

export function clearZulipComponentEntries(): void {
  componentEntries.clear();
}
