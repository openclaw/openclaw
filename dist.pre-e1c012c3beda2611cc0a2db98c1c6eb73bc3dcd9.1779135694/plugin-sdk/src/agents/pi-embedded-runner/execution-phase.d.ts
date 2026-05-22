export declare const EMBEDDED_AGENT_EXECUTION_PHASES: readonly ["runner_entered", "workspace", "runtime_plugins", "before_agent_reply", "model_resolution", "auth", "context_engine", "attempt_dispatch", "context_assembled", "turn_accepted", "process_spawned", "tool_execution_started", "assistant_output_started", "model_call_started"];
export type EmbeddedAgentExecutionPhase = (typeof EMBEDDED_AGENT_EXECUTION_PHASES)[number];
export declare const EMBEDDED_AGENT_EXECUTION_PHASE_LABELS: {
    readonly runner_entered: "runner-entered";
    readonly workspace: "workspace";
    readonly runtime_plugins: "runtime-plugins";
    readonly before_agent_reply: "before-agent-reply";
    readonly model_resolution: "model-resolution";
    readonly auth: "auth";
    readonly context_engine: "context-engine";
    readonly attempt_dispatch: "attempt-dispatch";
    readonly context_assembled: "context-assembled";
    readonly turn_accepted: "turn-accepted";
    readonly process_spawned: "process-spawned";
    readonly tool_execution_started: "tool-execution-started";
    readonly assistant_output_started: "assistant-output-started";
    readonly model_call_started: "model-call-started";
};
export declare function formatEmbeddedAgentExecutionPhase(phase?: EmbeddedAgentExecutionPhase): string | undefined;
