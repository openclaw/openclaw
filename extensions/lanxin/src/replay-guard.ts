import path from "node:path";
import { createPersistentDedupe } from "openclaw/plugin-sdk/lanxin";

const DEFAULT_REPLAY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MEMORY_MAX_SIZE = 2_000;
const DEFAULT_FILE_MAX_ENTRIES = 20_000;

function sanitizeSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function buildReplayKey(eventId: string): string | null {
  const normalized = eventId.trim();
  if (!normalized) {
    return null;
  }
  return normalized;
}

export type LanxinReplayGuardOptions = {
  stateDir: string;
  ttlMs?: number;
  memoryMaxSize?: number;
  fileMaxEntries?: number;
  onDiskError?: (error: unknown) => void;
};

export type LanxinReplayGuard = {
  shouldProcessEvent: (params: { accountId: string; eventId: string }) => Promise<boolean>;
};

export function createLanxinReplayGuard(options: LanxinReplayGuardOptions): LanxinReplayGuard {
  const stateDir = options.stateDir.trim();
  const persistentDedupe = createPersistentDedupe({
    ttlMs: options.ttlMs ?? DEFAULT_REPLAY_TTL_MS,
    memoryMaxSize: options.memoryMaxSize ?? DEFAULT_MEMORY_MAX_SIZE,
    fileMaxEntries: options.fileMaxEntries ?? DEFAULT_FILE_MAX_ENTRIES,
    resolveFilePath: (namespace) =>
      path.join(stateDir, "lanxin", "replay-dedupe", `${sanitizeSegment(namespace)}.json`),
  });

  return {
    shouldProcessEvent: async ({ accountId, eventId }) => {
      const replayKey = buildReplayKey(eventId);
      if (!replayKey) {
        return true;
      }
      return await persistentDedupe.checkAndRecord(replayKey, {
        namespace: accountId,
        onDiskError: options.onDiskError,
      });
    },
  };
}
