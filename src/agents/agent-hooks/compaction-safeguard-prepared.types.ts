import type { recoverCompactionSafeguardFailure } from "../compaction-summary-refusal.js";
import type { summarizeCompactionHistory } from "../compaction.js";
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

/** Host-only effects attached after read admission; never part of the worker reply. */
export type PreparedCompactionSafeguardExecution = {
  facts: PreparedCompactionSafeguardFacts;
  summarize: (
    source: "history" | "turnPrefix",
    params: Omit<Parameters<typeof summarizeCompactionHistory>[0], "messages">,
  ) => Promise<string>;
  recover: (error: unknown) => ReturnType<typeof recoverCompactionSafeguardFailure>;
};
