import path from "node:path";
import { createPersistentDedupe } from "openclaw/plugin-sdk/nextcloud-talk";
const DEFAULT_REPLAY_TTL_MS = 24 * 60 * 60 * 1e3;
const DEFAULT_MEMORY_MAX_SIZE = 1e3;
const DEFAULT_FILE_MAX_ENTRIES = 1e4;
function sanitizeSegment(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-zA-Z0-9_-]/g, "_");
}
function buildReplayKey(params) {
  const roomToken = params.roomToken.trim();
  const messageId = params.messageId.trim();
  if (!roomToken || !messageId) {
    return null;
  }
  return `${roomToken}:${messageId}`;
}
function createNextcloudTalkReplayGuard(options) {
  const stateDir = options.stateDir.trim();
  const persistentDedupe = createPersistentDedupe({
    ttlMs: options.ttlMs ?? DEFAULT_REPLAY_TTL_MS,
    memoryMaxSize: options.memoryMaxSize ?? DEFAULT_MEMORY_MAX_SIZE,
    fileMaxEntries: options.fileMaxEntries ?? DEFAULT_FILE_MAX_ENTRIES,
    resolveFilePath: (namespace) => path.join(stateDir, "nextcloud-talk", "replay-dedupe", `${sanitizeSegment(namespace)}.json`)
  });
  return {
    shouldProcessMessage: async ({ accountId, roomToken, messageId }) => {
      const replayKey = buildReplayKey({ roomToken, messageId });
      if (!replayKey) {
        return true;
      }
      return await persistentDedupe.checkAndRecord(replayKey, {
        namespace: accountId,
        onDiskError: options.onDiskError
      });
    }
  };
}
export {
  createNextcloudTalkReplayGuard
};
