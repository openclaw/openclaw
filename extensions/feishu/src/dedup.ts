import os from "node:os";
import path from "node:path";
import {
  createDedupeCache,
  createPersistentDedupe,
  readJsonFileWithFallback,
} from "openclaw/plugin-sdk/feishu";

// Persistent TTL: 24 hours — survives restarts & WebSocket reconnects.
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const MEMORY_MAX_SIZE = 1_000;
const FILE_MAX_ENTRIES = 10_000;
type PersistentDedupeData = Record<string, number>;

const memoryDedupe = createDedupeCache({ ttlMs: DEDUP_TTL_MS, maxSize: MEMORY_MAX_SIZE });

function resolveStateDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const stateOverride = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (stateOverride) {
    return stateOverride;
  }
  if (env.VITEST || env.NODE_ENV === "test") {
    return path.join(os.tmpdir(), ["openclaw-vitest", String(process.pid)].join("-"));
  }
  return path.join(os.homedir(), ".openclaw");
}

function resolveNamespaceFilePath(namespace: string): string {
  const safe = namespace.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(resolveStateDirFromEnv(), "feishu", "dedup", `${safe}.json`);
}

const persistentDedupe = createPersistentDedupe({
  ttlMs: DEDUP_TTL_MS,
  memoryMaxSize: MEMORY_MAX_SIZE,
  fileMaxEntries: FILE_MAX_ENTRIES,
  resolveFilePath: resolveNamespaceFilePath,
});

/**
 * Synchronous dedup — memory only.
 * Kept for backward compatibility; prefer {@link tryRecordMessagePersistent}.
 */
export function tryRecordMessage(messageId: string): boolean {
  return !memoryDedupe.check(messageId);
}

export function hasRecordedMessage(messageId: string): boolean {
  const trimmed = messageId.trim();
  if (!trimmed) {
    return false;
  }
  return memoryDedupe.peek(trimmed);
}

export async function tryRecordMessagePersistent(
  messageId: string,
  namespace = "global",
  log?: (...args: unknown[]) => void,
): Promise<boolean> {
  return persistentDedupe.checkAndRecord(messageId, {
    namespace,
    onDiskError: (error) => {
      log?.(`feishu-dedup: disk error, falling back to memory: ${String(error)}`);
    },
  });
}

export async function hasRecordedMessagePersistent(
  messageId: string,
  namespace = "global",
  log?: (...args: unknown[]) => void,
): Promise<boolean> {
  const trimmed = messageId.trim();
  if (!trimmed) {
    return false;
  }
  const now = Date.now();
  const filePath = resolveNamespaceFilePath(namespace);
  try {
    const { value } = await readJsonFileWithFallback<PersistentDedupeData>(filePath, {});
    const seenAt = value[trimmed];
    if (typeof seenAt !== "number" || !Number.isFinite(seenAt)) {
      return false;
    }
    return DEDUP_TTL_MS <= 0 || now - seenAt < DEDUP_TTL_MS;
  } catch (error) {
    log?.(`feishu-dedup: persistent peek failed: ${String(error)}`);
    return false;
  }
}

export async function warmupDedupFromDisk(
  namespace: string,
  log?: (...args: unknown[]) => void,
): Promise<number> {
  return persistentDedupe.warmup(namespace, (error) => {
    log?.(`feishu-dedup: warmup disk error: ${String(error)}`);
  });
}

// --- Time-based stale message rejection ---
// Per chat+sender last-processed create_time tracker.
// Key: "account:chatId:senderId", Value: last processed create_time (ms)
const lastProcessedCreateTime = new Map<string, number>();

/**
 * Check if a message is stale based on its create_time.
 * Returns `true` if the message should be processed (is fresh).
 * Returns `false` if the message is stale (create_time ≤ last processed).
 *
 * When createTimeMs is undefined/0, skip the check (allow processing)
 * so synthetic events and messages without timestamps are unaffected.
 */
export function checkAndRecordCreateTime(
  chatSenderKey: string,
  createTimeMs: number | undefined,
): boolean {
  if (!createTimeMs || createTimeMs <= 0) {
    return true;
  }
  const lastTime = lastProcessedCreateTime.get(chatSenderKey);
  if (lastTime !== undefined && createTimeMs <= lastTime) {
    return false;
  }
  lastProcessedCreateTime.set(chatSenderKey, createTimeMs);
  return true;
}
