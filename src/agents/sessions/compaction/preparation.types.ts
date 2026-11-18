import type { CompactionSettings } from "../../../../packages/agent-core/src/harness/compaction/compaction.js";

/** Ephemeral foreground facts; a separately routed summarizer cannot reconstruct these. */
export type CompactionRequestBudget = Readonly<{
  contextWindow: number;
  reserveTokens: number;
  fixedTokens: number;
  pendingTokens: number;
  /** Known queue reservation, replaced by the SDK's projected queue at submission. */
  pendingQueuedContextTokens?: number;
  /** Overlap credit applies only to the user body, never newly added context. */
  pendingUserTokens?: number;
  pendingUserIdempotencyKey?: string;
}>;

/** Input preservation exists before the foreground prompt can supply a token budget. */
export type CompactionRequestConstraints = Readonly<{
  requestBudget?: CompactionRequestBudget;
  /** Source of the active run, including after its input has been processed. */
  requestFromEntryId?: string;
  pendingUserEntryId?: string;
  /** The pending request cannot run until this compaction commits, such as a required preflight. */
  requestRequiresCompaction?: true;
}>;

// "deterministic" makes no model call: the host commits compactWithoutSummary after a failed summary.
export type CompactionSummaryOutputPolicy = "none" | "retry-invalid-once" | "deterministic";

export type AgentCompactionPreparationOptions = CompactionRequestConstraints & {
  itemId: string;
  settings: CompactionSettings;
  /** SDK work mode, not the foreground runtime's trigger: budgeted work can be manual. */
  mode: "manual" | "auto";
  summaryOutputPolicy: CompactionSummaryOutputPolicy;
  requestState?: "unresolved";
  contextWindow?: number;
  systemPrompt?: string;
  tools?: readonly { name: string; description: string; parameters: unknown }[];
};
