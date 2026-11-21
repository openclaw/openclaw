import type { AgentRunTerminalFacts } from "@openclaw/normalization-core/agent-run-terminal-outcome";

export type AgentRunTerminalOutcome = AgentRunTerminalFacts & {
  /** Exact active-only input delivery; the surrounding outcome completes input processing, not the target run. */
  activeSteer?: {
    runId: string;
    status: "accepted" | "rejected" | "indeterminate";
    reason?: string;
  };
  error?: string;
  startedAt?: number;
  endedAt?: number;
};
