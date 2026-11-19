export type SessionInitialMetadataFacts = {
  /** Whether the restored SDK context contains any messages, including summaries. */
  hasExistingSession: boolean;
  /** Whether the active branch contains a thinking-level entry. */
  hasThinkingEntry: boolean;
};
