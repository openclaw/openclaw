/** Carries and discovers canonical terminal outcomes through thrown-error boundaries. */
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import type { AgentRunTerminalOutcome } from "./agent-run-terminal-outcome.js";

/** Carries a canonical terminal outcome when an embedded attempt exits by throwing. */
export class AgentRunTerminalOutcomeError extends Error {
  readonly terminalOutcome: AgentRunTerminalOutcome;

  constructor(error: unknown, terminalOutcome: AgentRunTerminalOutcome) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = "AgentRunTerminalOutcomeError";
    this.terminalOutcome = terminalOutcome;
  }
}

/** Finds a canonical terminal outcome through ordinary error wrapper boundaries. */
export function findAgentRunTerminalOutcome(error: unknown): AgentRunTerminalOutcome | undefined {
  for (const candidate of collectNestedErrorCandidates(error)) {
    if (candidate instanceof AgentRunTerminalOutcomeError) {
      return candidate.terminalOutcome;
    }
  }
  return undefined;
}
