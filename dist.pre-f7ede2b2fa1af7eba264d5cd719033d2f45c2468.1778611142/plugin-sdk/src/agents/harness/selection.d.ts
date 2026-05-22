import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CompactEmbeddedPiSessionParams } from "../pi-embedded-runner/compact.types.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "../pi-embedded-runner/run/types.js";
import type { EmbeddedPiCompactResult } from "../pi-embedded-runner/types.js";
import { resolveAgentHarnessPolicy, type AgentHarnessPolicy } from "./policy.js";
import type { AgentHarness } from "./types.js";
export { resolveAgentHarnessPolicy };
export type { AgentHarnessPolicy };
export declare function selectAgentHarness(params: {
    provider: string;
    modelId?: string;
    config?: OpenClawConfig;
    agentId?: string;
    sessionKey?: string;
    agentHarnessId?: string;
}): AgentHarness;
export declare function runAgentHarnessAttempt(params: EmbeddedRunAttemptParams): Promise<EmbeddedRunAttemptResult>;
export declare function maybeCompactAgentHarnessSession(params: CompactEmbeddedPiSessionParams): Promise<EmbeddedPiCompactResult | undefined>;
