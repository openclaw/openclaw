import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type EmbeddedAgentRuntime } from "../pi-embedded-runner/runtime.js";
export type AgentHarnessPolicy = {
    runtime: EmbeddedAgentRuntime;
    runtimeSource?: "model" | "provider" | "implicit";
};
export declare function resolveAgentHarnessPolicy(params: {
    provider?: string;
    modelId?: string;
    config?: OpenClawConfig;
    agentId?: string;
    sessionKey?: string;
    env?: NodeJS.ProcessEnv;
}): AgentHarnessPolicy;
