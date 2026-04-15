export {
  type DedupeMatch,
  type DedupeOptions,
  DEFAULT_JACCARD_THRESHOLD,
  DEFAULT_LOOKBACK_MS,
  DEFAULT_SCAN_CAP,
  findLexicalDuplicate,
  upsertIngestText,
} from "./dedupe.js";
export {
  type Candidate,
  type CandidateMemoryType,
  type ExtractOptions,
  DEFAULT_INGEST_STATUS,
  extractCandidates,
} from "./extract.js";
export {
  type IngestContext,
  type IngestDeps,
  type IngestEvent,
  type IngestOutcome,
  findLastUserText,
  runIngest,
} from "./handler.js";
export { ensureIngestSchema } from "./ingest-schema.js";
export { contentHash, jaccard, normalizeForMatch, tokenize } from "./normalize.js";
export { looksLikeSecret } from "./secret-filter.js";
export { CONVERSATION_PATH_PREFIX, synthesizeConversationRef } from "./synthetic-ref.js";
