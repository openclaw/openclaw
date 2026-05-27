// Real workspace contract for QMD/session/query helpers used by the memory engine.

export { extractKeywords, isQueryStopWordToken } from "./host/query-expansion.js";
export {
  buildSessionEntry,
  listSessionFilesForAgent,
  loadDreamingNarrativeTranscriptPathSetForAgent,
  loadSessionTranscriptClassificationForAgent,
  normalizeSessionTranscriptPathForComparison,
  sessionPathForFile,
  type BuildSessionEntryOptions,
  type SessionFileEntry,
  type SessionTranscriptClassification,
} from "./host/session-files.js";
export {
  isSessionArchiveArtifactName,
  isUsageCountedSessionTranscriptFileName,
  parseUsageCountedSessionIdFromFileName,
} from "./host/openclaw-runtime-session.js";
export { parseQmdQueryJson, type QmdQueryResult } from "./host/qmd-query-parser.js";
export {
  deriveQmdScopeChannel,
  deriveQmdScopeChatType,
  isQmdScopeAllowed,
} from "./host/qmd-scope.js";
export {
  checkQmdBinaryAvailability,
  isCliCommandError,
  resolveCliSpawnInvocation,
  resolveQmdBinaryUnavailableReason,
  runCliCommand,
  type CliCommandError,
  type QmdBinaryAvailability,
  type QmdBinaryUnavailable,
  type QmdBinaryUnavailableReason,
} from "./host/qmd-process.js";
