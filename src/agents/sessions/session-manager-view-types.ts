import type { SessionTranscriptBoundedActiveContext } from "../../config/sessions/session-accessor.sqlite-contract.js";
import type { PreparedSessionTranscriptHydration } from "../../config/sessions/session-transcript-worker.types.js";
import type { SessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";

export type SessionManagerPersistenceTarget = SessionTranscriptTargetBinding;
export type SessionManagerBoundedContextLimits = { maxBytes: number; maxEvents: number };
export type PreparedSessionTranscriptReload = PreparedSessionTranscriptHydration;
export type SessionManagerBoundedView = Pick<
  SessionTranscriptBoundedActiveContext,
  | "activeLeafEntryId"
  | "version"
  | "opaqueParents"
  | "parents"
  | "firstKeptRanges"
  | "cacheTtlProjectionPrefixes"
>;
export type SessionManagerBoundedContext = SessionManagerBoundedView &
  Pick<
    SessionTranscriptBoundedActiveContext,
    "persistedSuffixStartSeq" | "boundaryCount" | "transcriptMutationAt"
  > & { limits: SessionManagerBoundedContextLimits };
