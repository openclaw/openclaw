import type { AgentRunTerminalFacts } from "@openclaw/normalization-core/agent-run-terminal-outcome";

/** Normalized terminal outcome for an agent run. */
export type AgentRunTerminalOutcome = AgentRunTerminalFacts & {
  error?: string;
  /** Native settlement fact; transport projections use the existing error fields. */
  cleanupError?: string;
  startedAt?: number;
  endedAt?: number;
};
