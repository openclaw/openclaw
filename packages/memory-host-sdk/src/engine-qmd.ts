// Real workspace contract for QMD/session/query helpers used by the memory engine.

export { extractKeywords, isQueryStopWordToken } from "./host/query-expansion.js";
export {
  buildSessionTranscriptEntry,
  listSessionTranscriptsForAgent,
  loadDreamingNarrativeTranscriptPathSetForAgent,
  loadSessionTranscriptClassificationForAgent,
  normalizeSessionTranscriptPathForComparison,
  readSessionTranscriptDeltaStats,
  resolveSessionTranscriptScope,
  sessionPathForTranscript,
  type BuildSessionTranscriptEntryOptions,
  type SessionTranscriptEntry,
  type SessionTranscriptDeltaStats,
  type SessionTranscriptClassification,
} from "./host/session-transcripts.js";
export {
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
  resolveCliSpawnInvocation,
  runCliCommand,
} from "./host/qmd-process.js";
