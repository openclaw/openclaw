// Real workspace contract for QMD/session/query helpers used by the memory engine.

export { extractKeywords, isQueryStopWordToken } from "./host/query-expansion.js";
export {
  buildSessionEntry,
  listSessionFilesForAgent,
  listSessionTranscriptCorpusEntriesForAgent,
  loadDreamingNarrativeTranscriptPathSetForAgent,
  loadSessionTranscriptClassificationForAgent,
  normalizeSessionTranscriptPathForComparison,
  parseCanonicalSessionSyncTargetFromPath,
  resolveSessionIdentityForTranscriptFile,
  resolveSessionFileForSyncTarget,
  sessionPathForFile,
  type BuildSessionEntryOptions,
  type ResolvedMemorySessionSyncTarget,
  type ResolvedSessionTranscriptIdentity,
  type SessionFileEntry,
  type SessionTranscriptClassification,
  type SessionTranscriptCorpusEntry,
} from "./host/session-files.js";
export {
  isCronRunSessionKey,
  isPrimarySessionTranscriptFileName,
  isSessionArchiveArtifactName,
  isUsageCountedSessionTranscriptFileName,
  parseUsageCountedSessionIdFromFileName,
  resolveSessionTranscriptsDirForAgent,
} from "./host/openclaw-runtime-session.js";
export { parseQmdQueryJson, type QmdQueryResult } from "./host/qmd-query-parser.js";
export {
  deriveQmdScopeChannel,
  deriveQmdScopeChatType,
  isQmdScopeAllowed,
} from "./host/qmd-scope.js";
export {
  checkQmdBinaryAvailability,
  resolveCliSpawnInvocation,
  resolveQmdBinaryUnavailableReason,
  runCliCommand,
  type QmdBinaryAvailability,
  type QmdBinaryUnavailable,
  type QmdBinaryUnavailableReason,
} from "./host/qmd-process.js";
