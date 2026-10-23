import { sha256Hex as digestText } from "openclaw/plugin-sdk/node-crypto-runtime";
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
  key: string;
  createdAt: number;
  createdAtSkewToleranceMs: number;
  rememberedAt: number;
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

function buildScope(parts: SelfChatCacheKeyParts): string {
  if (!parts.isGroup) {
    return `${parts.accountId}:imessage:${parts.sender}`;
  }
  const chatTarget = formatIMessageChatTarget(parts.chatId) || "chat_id:unknown";
  return `${parts.accountId}:${chatTarget}:imessage:${parts.sender}`;
}

export class SelfChatCache {
  private entries: SelfChatCacheEntry[] = [];
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
    this.entries.push({
      key,
      createdAt: lookup.createdAt,
      createdAtSkewToleranceMs: lookup.allowCreatedAtSkew ? SELF_CHAT_CREATED_AT_TOLERANCE_MS : 0,
      rememberedAt: Date.now(),
    });
    this.maybeCleanup();
  }

  has(lookup: SelfChatLookup): boolean {
    this.maybeCleanup();
    const key = this.buildBucketKey(lookup);
    if (!key || !isUsableTimestamp(lookup.createdAt)) {
      return false;
    }
    const now = Date.now();
    const createdAt = lookup.createdAt;
    return this.entries.some((entry) => {
      const createdAtDelta = Math.abs(entry.createdAt - createdAt);
      return (
        entry.key === key &&
        now - entry.rememberedAt <= SELF_CHAT_TTL_MS &&
        (createdAtDelta === 0 || createdAtDelta < entry.createdAtSkewToleranceMs)
      );
    });
  }

  private maybeCleanup(): void {
    const now = Date.now();
    if (now - this.lastCleanupAt < CLEANUP_MIN_INTERVAL_MS) {
      return;
    }
    this.lastCleanupAt = now;
    this.entries = this.entries
      .filter((entry) => now - entry.rememberedAt <= SELF_CHAT_TTL_MS)
      .slice(-MAX_SELF_CHAT_CACHE_ENTRIES);
  }
}
