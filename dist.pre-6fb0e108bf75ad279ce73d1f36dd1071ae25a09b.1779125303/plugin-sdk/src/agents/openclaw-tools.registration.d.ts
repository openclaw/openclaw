import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AnyAgentTool } from "./tools/common.js";
export declare function collectPresentOpenClawTools(candidates: readonly (AnyAgentTool | null | undefined)[]): AnyAgentTool[];
export declare function isUpdatePlanToolEnabledForOpenClawTools(params: {
    config?: OpenClawConfig;
    agentSessionKey?: string;
    agentId?: string | null;
    modelProvider?: string;
    modelId?: string;
}): boolean;
