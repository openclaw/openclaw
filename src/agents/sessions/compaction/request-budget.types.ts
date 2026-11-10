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
}>;
