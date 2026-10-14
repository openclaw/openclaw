import { createHash } from "node:crypto";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { formatIMessageChatTarget } from "../targets.js";

type SelfChatCacheKeyParts = {
  accountId: string;
  sender: string;
  isGroup: boolean;
  chatId?: number;
};

type SelfChatLookup = SelfChatCacheKeyParts & {
  text?: string;
  createdAt?: number;
  allowCreatedAtSkew?: boolean;
};

type SelfChatCacheEntry = {
  createdAt: number;
  createdAtSkewToleranceMs: number;
  rememberedAt: number;
};

export type SelfChatCache = {
  remember: (lookup: SelfChatLookup) => void;
  has: (lookup: SelfChatLookup) => boolean;
};

const SELF_CHAT_TTL_MS = 10_000;
const SELF_CHAT_CREATED_AT_TOLERANCE_MS = 1_000;
const MAX_SELF_CHAT_CACHE_ENTRIES = 512;
const CLEANUP_MIN_INTERVAL_MS = 1_000;

function normalizeText(text: string | undefined): string | null {
  if (!text) {
    return null;
  }
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  return normalized ? normalized : null;
}

function isUsableTimestamp(createdAt: number | undefined): createdAt is number {
  return typeof createdAt === "number" && Number.isFinite(createdAt);
}

function digestText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function buildScope(parts: SelfChatCacheKeyParts): string {
  if (!parts.isGroup) {
    return `${parts.accountId}:imessage:${parts.sender}`;
  }
  const chatTarget = formatIMessageChatTarget(parts.chatId) || "chat_id:unknown";
  return `${parts.accountId}:${chatTarget}:imessage:${parts.sender}`;
}

class DefaultSelfChatCache implements SelfChatCache {
  private cache = new Map<string, Set<SelfChatCacheEntry>>();
  private insertionOrder = new Map<SelfChatCacheEntry, string>();
  private lastCleanupAt = 0;

  private buildBucketKey(lookup: SelfChatLookup): string | null {
    const text = normalizeText(lookup.text);
    if (!text) {
      return null;
    }
    return `${buildScope(lookup)}:${digestText(text)}`;
  }

  remember(lookup: SelfChatLookup): void {
    const key = this.buildBucketKey(lookup);
    if (!key || !isUsableTimestamp(lookup.createdAt)) {
      return;
    }
    const entries = this.cache.get(key) ?? new Set<SelfChatCacheEntry>();
    const entry = {
      createdAt: lookup.createdAt,
      createdAtSkewToleranceMs: lookup.allowCreatedAtSkew ? SELF_CHAT_CREATED_AT_TOLERANCE_MS : 0,
      rememberedAt: Date.now(),
    };
    entries.add(entry);
    this.cache.set(key, entries);
    this.insertionOrder.set(entry, key);
    this.maybeCleanup();
  }

  has(lookup: SelfChatLookup): boolean {
    this.maybeCleanup();
    const key = this.buildBucketKey(lookup);
    if (!key || !isUsableTimestamp(lookup.createdAt)) {
      return false;
    }
    const entries = this.cache.get(key);
    if (!entries) {
      return false;
    }
    const now = Date.now();
    const createdAt = lookup.createdAt;
    return [...entries.values()].some((entry) => {
      const createdAtDelta = Math.abs(entry.createdAt - createdAt);
      return (
        now - entry.rememberedAt <= SELF_CHAT_TTL_MS &&
        (createdAtDelta === 0 || createdAtDelta < entry.createdAtSkewToleranceMs)
      );
    });
  }

  private removeEntry(entry: SelfChatCacheEntry, key: string): void {
    this.insertionOrder.delete(entry);
    const entries = this.cache.get(key);
    entries?.delete(entry);
    if (entries?.size === 0) {
      this.cache.delete(key);
    }
  }

  private maybeCleanup(): void {
    const now = Date.now();
    if (now - this.lastCleanupAt < CLEANUP_MIN_INTERVAL_MS) {
      return;
    }
    this.lastCleanupAt = now;
    for (const [entry, key] of this.insertionOrder) {
      if (now - entry.rememberedAt > SELF_CHAT_TTL_MS) {
        this.removeEntry(entry, key);
      }
    }
    while (this.insertionOrder.size > MAX_SELF_CHAT_CACHE_ENTRIES) {
      const [entry, key] = expectDefined(
        this.insertionOrder.entries().next().value,
        "oldest iMessage self-chat cache entry",
      );
      this.removeEntry(entry, key);
    }
  }
}

export function createSelfChatCache(): SelfChatCache {
  return new DefaultSelfChatCache();
}
