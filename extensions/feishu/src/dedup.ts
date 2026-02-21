// Prevent duplicate processing when WebSocket reconnects or Feishu redelivers messages.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEDUP_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours
const DEDUP_MAX_SIZE = 1_000;
const DEDUP_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // cleanup every 5 minutes
const processedMessageIds = new Map<string, number>(); // messageId -> timestamp
let lastCleanupTime = Date.now();

const DEDUP_FILE = path.join(os.homedir(), ".openclaw", "data", "feishu-dedup.json");

function loadFromFile(): void {
  try {
    const raw = fs.readFileSync(DEDUP_FILE, "utf8");
    const data = JSON.parse(raw) as { entries?: Record<string, number> };
    const now = Date.now();
    for (const [id, ts] of Object.entries(data.entries ?? {})) {
      if (now - ts < DEDUP_TTL_MS) {
        processedMessageIds.set(id, ts);
      }
    }
  } catch {
    // ignore
  }
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleWrite(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      const entries: Record<string, number> = {};
      for (const [id, ts] of processedMessageIds) entries[id] = ts;
      fs.mkdirSync(path.dirname(DEDUP_FILE), { recursive: true });
      const tmp = DEDUP_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ entries }));
      fs.renameSync(tmp, DEDUP_FILE);
    } catch {
      // ignore
    }
  }, 500);
}

loadFromFile();

export function tryRecordMessage(messageId: string): boolean {
  const now = Date.now();

  // Throttled cleanup: evict expired entries at most once per interval.
  if (now - lastCleanupTime > DEDUP_CLEANUP_INTERVAL_MS) {
    for (const [id, ts] of processedMessageIds) {
      if (now - ts > DEDUP_TTL_MS) {
        processedMessageIds.delete(id);
      }
    }
    lastCleanupTime = now;
    scheduleWrite();
  }

  if (processedMessageIds.has(messageId)) {
    return false;
  }

  // Evict oldest entries if cache is full.
  if (processedMessageIds.size >= DEDUP_MAX_SIZE) {
    const first = processedMessageIds.keys().next().value!;
    processedMessageIds.delete(first);
    scheduleWrite();
  }

  processedMessageIds.set(messageId, now);
  scheduleWrite();
  return true;
}
