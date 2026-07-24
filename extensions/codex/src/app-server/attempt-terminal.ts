import {
  agentHarnessAttemptTerminal,
  type AgentHarnessAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";

export type EmbeddedRunAttemptResult = Extract<AgentHarnessAttemptResult, { terminal: unknown }>;
export const attemptTerminal = agentHarnessAttemptTerminal;
export const readAttemptTerminal = (result: EmbeddedRunAttemptResult) =>
  attemptTerminal.project(result.terminal);
