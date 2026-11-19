import type { AgentMessage } from "../../../packages/agent-core/src/types.js";

export type ContextSection = {
  text: string;
  segmentStarts: number[];
  // Keep producer loss attached to the bounded artifact so every finalizer path
  // emits the same redacted diagnostic when the section already dropped context.
  truncatedLoss?: "split-turn-head" | "preserved-turn-head";
};

/** Data only: full source arrays never leave the preparation worker. */
export type PreparedCompactionSafeguardFacts = {
  previousSummary: string | undefined;
  history: { hasRealConversation: boolean; usedPreparationRange: boolean };
  sections: {
    copilotHeaders: Record<string, string>;
    readFiles: string[];
    modifiedFiles: string[];
    fileOpsSummary: string;
    toolFailureSection: string;
  };
  summary: {
    latestUserAsk: string | null;
    latestAskInRetainedTurn: boolean;
    identifiers: string[];
    requiredAskContext: string;
    preservedTurnsSection: ContextSection;
  };
  reconciliationCount: number;
  turnPrefixCount: number;
};

export type CompactionSafeguardSummary = PreparedCompactionSafeguardFacts["summary"] & {
  summarizableMessages: AgentMessage[];
  preservedMessages: AgentMessage[];
  splitTurnSection: ContextSection | undefined;
  turnPrefixMessages: AgentMessage[];
  oracleMessages: AgentMessage[];
  reconciliationMessages: AgentMessage[];
};
