import type { AgentHarnessAttemptResult as AgentHarnessAttemptResultContract } from "openclaw/plugin-sdk/agent-harness-runtime";

type AgentHarnessAttemptResult = Extract<AgentHarnessAttemptResultContract, { terminal: unknown }>;

export function projectAgentRunAttemptTerminal(terminal: AgentHarnessAttemptResult["terminal"]) {
  return {
    aborted: terminal.kind === "aborted" && terminal.source !== "yield_cleanup",
    promptError:
      terminal.kind === "failed"
        ? terminal.error
        : terminal.kind === "ok"
          ? null
          : (terminal.failure?.error ?? null),
    timedOut: terminal.kind === "timeout" && terminal.source !== "observation",
    timedOutDuringCompaction: terminal.kind === "timeout" && terminal.phase === "compaction",
  };
}
