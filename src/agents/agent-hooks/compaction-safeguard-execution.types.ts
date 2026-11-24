import type {
  CompactionPreparation,
  CompactionPreparationMetadata,
  CompactionResult,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import type { recoverCompactionSafeguardFailure } from "../compaction-summary-refusal.js";
import type { summarizeCompactionHistory } from "../compaction.js";
import type { ExtensionContext, ExtensionEvent } from "../sessions/extensions/types.js";
import type { PreparedCompactionSafeguardFacts } from "./compaction-safeguard-prepared.types.js";

/** Host-only effects attached after read admission; never part of the worker reply. */
export type PreparedCompactionSafeguardExecution = {
  facts: PreparedCompactionSafeguardFacts;
  summarize: (
    source: "history" | "turnPrefix",
    params: Omit<Parameters<typeof summarizeCompactionHistory>[0], "messages">,
  ) => Promise<string>;
  recover: (error: unknown) => ReturnType<typeof recoverCompactionSafeguardFailure>;
};

export type CompactionSafeguardResult =
  | { cancel: true; compaction?: never }
  | { cancel?: never; compaction: CompactionResult };

export type RunCompactionSafeguard = (
  event: Extract<ExtensionEvent, { type: "session_before_compact" }>,
  context: Pick<ExtensionContext, "model" | "modelRegistry" | "sessionManager">,
  prepared?: PreparedCompactionSafeguardExecution,
) => Promise<CompactionSafeguardResult>;

/** Effect identity is not a session manager and never exposes synchronous history. */
export type CompactionSafeguardContext = Pick<ExtensionContext, "model" | "modelRegistry"> & {
  identity: object;
  fullPreparation?: CompactionPreparation;
  readBranch?: () => import("../runtime/index.js").SessionTreeEntry[];
};
export type CompactionSafeguardEvent = Omit<
  Parameters<RunCompactionSafeguard>[0],
  "preparation" | "branchEntries"
> & {
  preparation: CompactionPreparationMetadata;
};
