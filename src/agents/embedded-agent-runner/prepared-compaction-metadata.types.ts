import type { SessionInitialMetadataFacts } from "../sessions/session-initial-metadata.types.js";
import type { ModelSnapshotEntry } from "./replay-session-state.types.js";

export type PreparedCompactionMetadataFacts = SessionInitialMetadataFacts & {
  leafEntryId: string | null;
  lastModelSnapshot: ModelSnapshotEntry | null;
};
