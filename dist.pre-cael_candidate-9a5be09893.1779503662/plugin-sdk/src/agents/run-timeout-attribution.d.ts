export declare const AGENT_RUN_TIMEOUT_PHASES: readonly ["queue", "preflight", "provider", "post_turn", "gateway_draining"];
export type AgentRunTimeoutPhase = (typeof AGENT_RUN_TIMEOUT_PHASES)[number];
export declare function normalizeAgentRunTimeoutPhase(value: unknown): AgentRunTimeoutPhase | undefined;
export declare function normalizeProviderStarted(value: unknown): boolean | undefined;
