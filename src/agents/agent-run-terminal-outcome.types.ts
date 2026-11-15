import type { AgentRunTerminalFacts } from "@openclaw/normalization-core/agent-run-terminal-outcome";

export type AgentRunTerminalOutcome = AgentRunTerminalFacts & {
  error?: string;
  startedAt?: number;
  endedAt?: number;
};
