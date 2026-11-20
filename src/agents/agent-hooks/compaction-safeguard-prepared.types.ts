import type {
  CompactionSafeguardHistory,
  prepareCompactionSafeguardSections,
  prepareCompactionSafeguardSummary,
} from "./compaction-safeguard-preparation.js";

/** Data only: full source arrays never leave the preparation worker. */
export type PreparedCompactionSafeguardFacts = {
  previousSummary: string | undefined;
  history: Pick<CompactionSafeguardHistory, "hasRealConversation" | "usedPreparationRange">;
  sections: ReturnType<typeof prepareCompactionSafeguardSections>;
  summary: Pick<
    ReturnType<typeof prepareCompactionSafeguardSummary>,
    | "latestUserAsk"
    | "latestAskInRetainedTurn"
    | "identifiers"
    | "requiredAskContext"
    | "preservedTurnsSection"
  >;
  reconciliationCount: number;
  turnPrefixCount: number;
};
