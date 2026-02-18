import { createHash } from "node:crypto";

export type SentMessageLookup = {
  text?: string;
  messageId?: string;
};

export type SentMessageCache = {
  remember: (scope: string, lookup: SentMessageLookup) => void;
  has: (scope: string, lookup: SentMessageLookup) => boolean;
};

/**
 * Bounded set of recently sent messages used for echo detection.
 * Uses SHA-256 for text keys so storage is fixed-size; no TTL so delayed
 * reflections (e.g. after slow LLM reply) still match.
 */
const MAX_ENTRIES = 200;

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function normalizeEchoTextKey(text: string | undefined): string | null {
  if (!text) {
    return null;
  }
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  return normalized ? normalized : null;
}

function normalizeEchoMessageIdKey(messageId: string | undefined): string | null {
  if (!messageId) {
    return null;
  }
  const normalized = messageId.trim();
  if (!normalized || normalized === "ok" || normalized === "unknown") {
    return null;
  }
  return normalized;
}

class DefaultSentMessageCache implements SentMessageCache {
  private entries: Array<{ scope: string; kind: "text" | "id"; key: string }> = [];
  private index = new Set<string>();

  private toStoreKey(scope: string, kind: "text" | "id", key: string): string {
    return `${scope}:${kind}:${key}`;
  }

  remember(scope: string, lookup: SentMessageLookup): void {
    const textKey = normalizeEchoTextKey(lookup.text);
    if (textKey) {
      const hashed = sha256Hex(textKey);
      const storeKey = this.toStoreKey(scope, "text", hashed);
      if (!this.index.has(storeKey)) {
        this.entries.push({ scope, kind: "text", key: hashed });
        this.index.add(storeKey);
        this.evict();
      }
    }
    const messageIdKey = normalizeEchoMessageIdKey(lookup.messageId);
    if (messageIdKey) {
      const storeKey = this.toStoreKey(scope, "id", messageIdKey);
      if (!this.index.has(storeKey)) {
        this.entries.push({ scope, kind: "id", key: messageIdKey });
        this.index.add(storeKey);
        this.evict();
      }
    }
  }

  has(scope: string, lookup: SentMessageLookup): boolean {
    const messageIdKey = normalizeEchoMessageIdKey(lookup.messageId);
    if (messageIdKey) {
      const storeKey = this.toStoreKey(scope, "id", messageIdKey);
      if (this.index.has(storeKey)) {
        return true;
      }
    }
    const textKey = normalizeEchoTextKey(lookup.text);
    if (textKey) {
      const hashed = sha256Hex(textKey);
      const storeKey = this.toStoreKey(scope, "text", hashed);
      if (this.index.has(storeKey)) {
        this.index.delete(storeKey);
        const idx = this.entries.findIndex(
          (e) => e.scope === scope && e.kind === "text" && e.key === hashed,
        );
        if (idx >= 0) {
          this.entries.splice(idx, 1);
        }
        return true;
      }
    }
    return false;
  }

  private evict(): void {
    while (this.entries.length > MAX_ENTRIES) {
      const e = this.entries.shift();
      if (e) {
        this.index.delete(this.toStoreKey(e.scope, e.kind, e.key));
      }
    }
  }
}

export function createSentMessageCache(): SentMessageCache {
  return new DefaultSentMessageCache();
}
