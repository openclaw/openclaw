import type { EmbeddedPiRunResult } from "../../../agents/pi-embedded-runner/types.js";
export declare const OUTCOME_FALLBACK_RUNTIME_CONTRACT: {
    readonly primaryProvider: "openai-codex";
    readonly primaryModel: "gpt-5.4";
    readonly fallbackProvider: "anthropic";
    readonly fallbackModel: "claude-haiku-3-5";
    readonly sessionId: "session-outcome-contract";
    readonly sessionKey: "agent:main:outcome-contract";
    readonly runId: "run-outcome-contract";
    readonly prompt: "finish the contract turn";
    readonly reasoningOnlyText: "I need to reason about this before answering.";
    readonly planningOnlyText: "Inspect state, then decide the next step.";
};
export declare function createContractRunResult(overrides?: Partial<EmbeddedPiRunResult>): EmbeddedPiRunResult;
export declare function createContractFallbackConfig(): {
    readonly agents: {
        readonly defaults: {
            readonly model: {
                readonly primary: "openai-codex/gpt-5.4";
                readonly fallbacks: readonly ["anthropic/claude-haiku-3-5"];
            };
        };
    };
};
