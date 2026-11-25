import type { AgentCompactionIdentifierPolicy } from "../config/types.agent-defaults.js";

export type CompactionSummarizationInstructions = {
  identifierPolicy?: AgentCompactionIdentifierPolicy | "custom";
  identifierInstructions?: string;
};
