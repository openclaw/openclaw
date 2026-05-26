import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AgentRuntimeAuthPlan } from "./types.js";
export declare function buildAgentRuntimeAuthPlan(params: {
    provider: string;
    authProfileProvider?: string;
    authProfileMode?: string;
    sessionAuthProfileId?: string;
    sessionAuthProfileCandidateIds?: string[];
    config?: OpenClawConfig;
    workspaceDir?: string;
    harnessId?: string;
    harnessRuntime?: string;
    allowHarnessAuthProfileForwarding?: boolean;
}): AgentRuntimeAuthPlan;
