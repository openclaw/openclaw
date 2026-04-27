import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CompactEmbeddedPiSessionParams } from "../pi-embedded-runner/compact.types.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "../pi-embedded-runner/run/types.js";
import { type EmbeddedAgentHarnessFallback, type EmbeddedAgentRuntime } from "../pi-embedded-runner/runtime.js";
import type { EmbeddedPiCompactResult } from "../pi-embedded-runner/types.js";
import type { AgentHarness } from "./types.js";
type AgentHarnessPolicy = {
    runtime: EmbeddedAgentRuntime;
    fallback: EmbeddedAgentHarnessFallback;
};
export declare function selectAgentHarness(params: {
    provider: string;
    modelId?: string;
    config?: OpenClawConfig;
    agentId?: string;
    sessionKey?: string;
    agentHarnessId?: string;
}): AgentHarness;
export declare function runAgentHarnessAttemptWithFallback(params: EmbeddedRunAttemptParams): Promise<EmbeddedRunAttemptResult>;
export declare function maybeCompactAgentHarnessSession(params: CompactEmbeddedPiSessionParams): Promise<EmbeddedPiCompactResult | undefined>;
export declare function resolveAgentHarnessPolicy(params: {
    provider?: string;
    modelId?: string;
    config?: OpenClawConfig;
    agentId?: string;
    sessionKey?: string;
    env?: NodeJS.ProcessEnv;
}): AgentHarnessPolicy;
export {};
