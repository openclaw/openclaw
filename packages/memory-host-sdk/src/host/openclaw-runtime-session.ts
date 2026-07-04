// Narrow session/runtime facade re-exported for memory transcript helpers.
import path from "node:path";

export {
  canonicalizeMainSessionAlias,
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
  HEARTBEAT_PROMPT,
  HEARTBEAT_TOKEN,
  SILENT_REPLY_TOKEN,
  hasInterSessionUserProvenance,
  isCompactionCheckpointTranscriptFileName,
  isCronRunSessionKey,
  isExecCompletionEvent,
  isHeartbeatUserMessage,
  isSessionArchiveArtifactName,
  isSilentReplyPayloadText,
  isUsageCountedSessionTranscriptFileName,
  listSessionEntries,
  onSessionTranscriptUpdate,
  parseUsageCountedSessionIdFromFileName,
  resolveSessionFilePath,
  resolveStorePath,
  resolveSessionAgentId,
  resolveSessionTranscriptsDirForAgent,
  stripInboundMetadata,
  stripInternalRuntimeContext,
  type SessionEntry,
} from "./openclaw-runtime.js";

/** Extracts the agent id from a canonical `agents/<id>/sessions` directory path. */
export function extractAgentIdFromSessionsDir(sessionsDir: string): string | null {
  const parts = path.normalize(path.resolve(sessionsDir)).split(path.sep).filter(Boolean);
  const sessionsIndex = parts.length - 1;
  if (
    parts[sessionsIndex] !== "sessions" ||
    sessionsIndex < 2 ||
    parts[sessionsIndex - 2] !== "agents"
  ) {
    return null;
  }
  return parts[sessionsIndex - 1] || null;
}
