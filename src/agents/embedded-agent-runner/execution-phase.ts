/**
 * Ordered execution milestones reported by the embedded runner while a turn starts up.
 *
 * Keep labels stable: external status surfaces and diagnostics consume the formatted values.
 */
const EMBEDDED_AGENT_EXECUTION_PHASE_LABELS = {
  runner_entered: "runner-entered",
  workspace: "workspace",
  runtime_plugins: "runtime-plugins",
  before_agent_reply: "before-agent-reply",
  model_resolution: "model-resolution",
  auth: "auth",
  context_engine: "context-engine",
  attempt_dispatch: "attempt-dispatch",
  context_assembled: "context-assembled",
  turn_accepted: "turn-accepted",
  process_spawned: "process-spawned",
  tool_execution_started: "tool-execution-started",
  assistant_output_started: "assistant-output-started",
  model_call_started: "model-call-started",
} as const;

export type EmbeddedAgentExecutionPhase = keyof typeof EMBEDDED_AGENT_EXECUTION_PHASE_LABELS;

/** Converts an internal phase id into the compact label used in status output. */
export function formatEmbeddedAgentExecutionPhase(
  phase?: EmbeddedAgentExecutionPhase,
): string | undefined {
  return phase ? EMBEDDED_AGENT_EXECUTION_PHASE_LABELS[phase] : undefined;
}
