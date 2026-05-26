import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { AgentRuntimePlan } from "../../runtime-plan/types.js";
import { type TranscriptPolicy } from "../../transcript-policy.js";
export type AttemptRuntimeModelContext = NonNullable<Parameters<AgentRuntimePlan["transcript"]["resolvePolicy"]>[0]>;
export declare function resolveAttemptTranscriptPolicy(params: {
    runtimePlan?: AgentRuntimePlan;
    runtimePlanModelContext: AttemptRuntimeModelContext;
    provider: string;
    modelId: string;
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
}): TranscriptPolicy;
