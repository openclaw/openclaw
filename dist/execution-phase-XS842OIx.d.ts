//#region src/agents/pi-embedded-runner/execution-phase.d.ts
declare const EMBEDDED_AGENT_EXECUTION_PHASES: readonly ["runner_entered", "workspace", "runtime_plugins", "before_agent_reply", "model_resolution", "auth", "context_engine", "attempt_dispatch", "context_assembled", "turn_accepted", "process_spawned", "tool_execution_started", "assistant_output_started", "model_call_started"];
type EmbeddedAgentExecutionPhase = (typeof EMBEDDED_AGENT_EXECUTION_PHASES)[number];
//#endregion
export { EmbeddedAgentExecutionPhase as t };