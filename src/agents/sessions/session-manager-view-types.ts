import type { SessionTranscriptBoundedActiveContext } from "../../config/sessions/session-accessor.sqlite-active-context.js";
import type { PreparedSessionTranscriptHydration } from "../../config/sessions/session-transcript-worker.types.js";
import type { SessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";

export type SessionManagerPersistenceTarget = SessionTranscriptTargetBinding;
export type SessionManagerBoundedContextLimits = { maxBytes: number; maxEvents: number };
export type PreparedSessionTranscriptReload = PreparedSessionTranscriptHydration;
export type SessionManagerBoundedContext = Pick<
  SessionTranscriptBoundedActiveContext,
  | "activeLeafEntryId"
  | "version"
  | "opaqueParents"
  | "parents"
  | "firstKeptRanges"
  | "persistedSuffixStartSeq"
  | "boundaryCount"
  | "transcriptMutationAt"
> & { limits: SessionManagerBoundedContextLimits };
