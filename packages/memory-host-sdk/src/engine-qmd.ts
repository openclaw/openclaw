// Real workspace contract for QMD helpers used by the memory engine.

export { extractKeywords, isQueryStopWordToken } from "./host/query-expansion.js";
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
// Compatibility only. New code imports SQLite-backed transcript helpers from
// engine-session-transcripts so the QMD surface stays about QMD.
export {
  buildSessionTranscriptEntry,
  listSessionTranscriptScopesForAgent,
  readSessionTranscriptDeltaStats,
  sessionTranscriptKeyForScope,
  type BuildSessionTranscriptEntryOptions,
  type SessionTranscriptDeltaStats,
  type SessionTranscriptEntry,
  type SessionTranscriptScope,
} from "./engine-session-transcripts.js";
