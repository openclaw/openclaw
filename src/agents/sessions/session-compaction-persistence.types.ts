import type {
  SessionTranscriptRuntimeTarget,
  SessionTranscriptWriteScope,
} from "../../config/sessions/session-accessor.types.js";
import type { SessionTranscriptContextVersion } from "../../config/sessions/session-transcript-context-version.types.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { CompactionEntry } from "./session-manager-types.js";

/** Prepared data only; the original runtime owner still authorizes the commit. */
export type PreparedCompactionAppend = {
  scope: SessionTranscriptRuntimeTarget &
    Pick<
      SessionTranscriptWriteScope,
      "env" | "expectedLifecycleRevision" | "expectedWriterRunId" | "expectedOwner"
    >;
  event: CompactionEntry;
  appendIntent?: "active-branch";
  expectedMutationAt?: number | null;
  initializeEntry?: boolean;
};

export type CommittedCompactionAppend = {
  result: CompactionEntry;
  before: SessionTranscriptContextVersion;
  after: SessionTranscriptContextVersion;
};

export type CommittedCompactionBoundary = CommittedCompactionAppend & {
  entry: InternalSessionEntry;
};
