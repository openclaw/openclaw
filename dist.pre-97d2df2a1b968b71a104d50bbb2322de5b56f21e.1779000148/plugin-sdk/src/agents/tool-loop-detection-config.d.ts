import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
export declare function resolveToolLoopDetectionConfig(params: {
    cfg?: OpenClawConfig;
    agentId?: string;
}): ToolLoopDetectionConfig | undefined;
