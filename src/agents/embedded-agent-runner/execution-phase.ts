import type { ChatRunStartupPhase } from "../../../packages/gateway-protocol/src/index.js";

// Keep labels stable: external status surfaces and diagnostics consume the formatted values.
const EMBEDDED_AGENT_EXECUTION_PHASES = {
  runner_entered: { label: "runner-entered", startupPhase: "preparing_workspace" },
  workspace: { label: "workspace", startupPhase: "preparing_workspace" },
  runtime_plugins: { label: "runtime-plugins", startupPhase: "preparing_workspace" },
  before_agent_reply: { label: "before-agent-reply", startupPhase: "preparing_context" },
  model_resolution: { label: "model-resolution", startupPhase: "preparing_context" },
  auth: { label: "auth", startupPhase: "preparing_context" },
  context_engine: { label: "context-engine", startupPhase: "preparing_context" },
  attempt_dispatch: { label: "attempt-dispatch", startupPhase: "preparing_context" },
  context_assembled: { label: "context-assembled", startupPhase: "preparing_context" },
  turn_accepted: { label: "turn-accepted", startupPhase: "starting_model" },
  process_spawned: { label: "process-spawned", startupPhase: "starting_model" },
  tool_execution_started: { label: "tool-execution-started", startupPhase: undefined },
  assistant_output_started: { label: "assistant-output-started", startupPhase: undefined },
  model_call_started: { label: "model-call-started", startupPhase: "starting_model" },
} as const;

export type EmbeddedAgentExecutionPhase = keyof typeof EMBEDDED_AGENT_EXECUTION_PHASES;

export function formatEmbeddedAgentExecutionPhase(
  phase?: EmbeddedAgentExecutionPhase,
): string | undefined {
  return phase ? EMBEDDED_AGENT_EXECUTION_PHASES[phase].label : undefined;
}

export function resolveRunStartupPhase(
  phase: EmbeddedAgentExecutionPhase,
): ChatRunStartupPhase | undefined {
  return EMBEDDED_AGENT_EXECUTION_PHASES[phase].startupPhase;
}
