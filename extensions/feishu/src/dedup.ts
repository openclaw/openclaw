import { createHash } from "node:crypto";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  releaseFeishuMessageProcessing,
  tryBeginFeishuMessageProcessing,
} from "./processing-claims.js";

// Persistent TTL: 24 hours — survives restarts & WebSocket reconnects.
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const MEMORY_MAX_SIZE = 1_000;
const STORE_MAX_ENTRIES = 50_000;
const FEISHU_DEDUP_STORE = createPluginStateSyncKeyedStore<{
  namespace: string;
  messageId: string;
  seenAt: number;
}>("feishu", {
  namespace: "dedup",
  maxEntries: STORE_MAX_ENTRIES,
  defaultTtlMs: DEDUP_TTL_MS,
});
const memory = new Map<string, number>();

function normalizeMessageId(messageId: string | undefined | null): string | null {
  const trimmed = messageId?.trim();
  return trimmed ? trimmed : null;
}

function normalizeNamespace(namespace?: string): string {
  return namespace?.trim() || "global";
}

function dedupeStoreKey(namespace: string, messageId: string): string {
  return createHash("sha256")
    .update(`${namespace}\0${messageId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function memoryKey(namespace: string, messageId: string): string {
  return `${namespace}\0${messageId}`;
}

function isRecent(seenAt: number | undefined, now = Date.now()): boolean {
  return typeof seenAt === "number" && Number.isFinite(seenAt) && now - seenAt < DEDUP_TTL_MS;
}

function pruneMemory(now = Date.now()): void {
  for (const [key, seenAt] of memory) {
    if (!isRecent(seenAt, now)) {
      memory.delete(key);
    }
  }
  if (memory.size <= MEMORY_MAX_SIZE) {
    return;
  }
  const toRemove = Array.from(memory.entries())
    .toSorted(([, left], [, right]) => left - right)
    .slice(0, memory.size - MEMORY_MAX_SIZE);
  for (const [key] of toRemove) {
    memory.delete(key);
  }
}

function remember(namespace: string, messageId: string, seenAt = Date.now()): void {
  memory.set(memoryKey(namespace, messageId), seenAt);
  pruneMemory(seenAt);
}

function hasMemory(namespace: string, messageId: string, now = Date.now()): boolean {
  const key = memoryKey(namespace, messageId);
  const seenAt = memory.get(key);
  if (isRecent(seenAt, now)) {
    return true;
  }
  memory.delete(key);
  return false;
}

export { releaseFeishuMessageProcessing, tryBeginFeishuMessageProcessing };

export async function claimUnprocessedFeishuMessage(params: {
  messageId: string | undefined | null;
  namespace?: string;
  log?: (...args: unknown[]) => void;
}): Promise<"claimed" | "duplicate" | "inflight" | "invalid"> {
  const { messageId, namespace = "global", log } = params;
  const normalizedMessageId = normalizeMessageId(messageId);
  if (!normalizedMessageId) {
    return "invalid";
  }
  if (await hasProcessedFeishuMessage(normalizedMessageId, namespace, log)) {
    return "duplicate";
  }
  if (!tryBeginFeishuMessageProcessing(normalizedMessageId, namespace)) {
    return "inflight";
  }
  return "claimed";
}

export async function finalizeFeishuMessageProcessing(params: {
  messageId: string | undefined | null;
  namespace?: string;
  log?: (...args: unknown[]) => void;
  claimHeld?: boolean;
}): Promise<boolean> {
  const { messageId, namespace = "global", log, claimHeld = false } = params;
  const normalizedMessageId = normalizeMessageId(messageId);
  if (!normalizedMessageId) {
    return false;
  }
  if (!claimHeld && !tryBeginFeishuMessageProcessing(normalizedMessageId, namespace)) {
    return false;
  }
  if (!(await tryRecordMessagePersistent(normalizedMessageId, namespace, log))) {
    releaseFeishuMessageProcessing(normalizedMessageId, namespace);
    return false;
  }
  return true;
}

export async function recordProcessedFeishuMessage(
  messageId: string | undefined | null,
  namespace = "global",
  log?: (...args: unknown[]) => void,
): Promise<boolean> {
  const normalizedMessageId = normalizeMessageId(messageId);
  if (!normalizedMessageId) {
    return false;
  }
  return await tryRecordMessagePersistent(normalizedMessageId, namespace, log);
}

export async function hasProcessedFeishuMessage(
  messageId: string | undefined | null,
  namespace = "global",
  log?: (...args: unknown[]) => void,
): Promise<boolean> {
  const normalizedMessageId = normalizeMessageId(messageId);
  if (!normalizedMessageId) {
    return false;
  }
  return hasRecordedMessagePersistent(normalizedMessageId, namespace, log);
}

export async function tryRecordMessagePersistent(
  messageId: string,
  namespace = "global",
  log?: (...args: unknown[]) => void,
): Promise<boolean> {
  const normalizedNamespace = normalizeNamespace(namespace);
  const normalizedMessageId = normalizeMessageId(messageId);
  if (!normalizedMessageId) {
    return true;
  }
  const now = Date.now();
  if (hasMemory(normalizedNamespace, normalizedMessageId, now)) {
    return false;
  }
  const key = dedupeStoreKey(normalizedNamespace, normalizedMessageId);
  try {
    const existing = FEISHU_DEDUP_STORE.lookup(key);
    const existingSeenAt = existing?.seenAt;
    if (isRecent(existingSeenAt, now)) {
      remember(normalizedNamespace, normalizedMessageId, existingSeenAt);
      return false;
    }
    const recorded = FEISHU_DEDUP_STORE.registerIfAbsent(
      key,
      {
        namespace: normalizedNamespace,
        messageId: normalizedMessageId,
        seenAt: now,
      },
      { ttlMs: DEDUP_TTL_MS },
    );
    if (!recorded) {
      const current = FEISHU_DEDUP_STORE.lookup(key);
      const currentSeenAt = current?.seenAt;
      if (isRecent(currentSeenAt, now)) {
        remember(normalizedNamespace, normalizedMessageId, currentSeenAt);
        return false;
      }
      FEISHU_DEDUP_STORE.register(
        key,
        {
          namespace: normalizedNamespace,
          messageId: normalizedMessageId,
          seenAt: now,
        },
        { ttlMs: DEDUP_TTL_MS },
      );
    }
    remember(normalizedNamespace, normalizedMessageId, now);
    return true;
  } catch (error) {
    log?.(`feishu-dedup: persistent state error, falling back to memory: ${String(error)}`);
    remember(normalizedNamespace, normalizedMessageId, now);
    return true;
  }
}

async function hasRecordedMessagePersistent(
  messageId: string,
  namespace = "global",
  log?: (...args: unknown[]) => void,
): Promise<boolean> {
  const normalizedNamespace = normalizeNamespace(namespace);
  const normalizedMessageId = normalizeMessageId(messageId);
  if (!normalizedMessageId) {
    return false;
  }
  const now = Date.now();
  if (hasMemory(normalizedNamespace, normalizedMessageId, now)) {
    return true;
  }
  try {
    const existing = FEISHU_DEDUP_STORE.lookup(
      dedupeStoreKey(normalizedNamespace, normalizedMessageId),
    );
    const existingSeenAt = existing?.seenAt;
    if (!isRecent(existingSeenAt, now)) {
      return false;
    }
    remember(normalizedNamespace, normalizedMessageId, existingSeenAt);
    return true;
  } catch (error) {
    log?.(`feishu-dedup: persistent peek failed: ${String(error)}`);
    return hasMemory(normalizedNamespace, normalizedMessageId, now);
  }
}

export async function warmupDedupFromDisk(
  namespace: string,
  log?: (...args: unknown[]) => void,
): Promise<number> {
  const normalizedNamespace = normalizeNamespace(namespace);
  try {
    let loaded = 0;
    const now = Date.now();
    for (const entry of FEISHU_DEDUP_STORE.entries()) {
      if (entry.value.namespace !== normalizedNamespace || !isRecent(entry.value.seenAt, now)) {
        continue;
      }
      remember(normalizedNamespace, entry.value.messageId, entry.value.seenAt);
      loaded++;
    }
    return loaded;
  } catch (error) {
    log?.(`feishu-dedup: warmup persistent state error: ${String(error)}`);
    return 0;
  }
}

export const __testing = {
  resetFeishuDedupForTests() {
    memory.clear();
    FEISHU_DEDUP_STORE.clear();
  },
  resetFeishuDedupMemoryForTests() {
    memory.clear();
  },
};
