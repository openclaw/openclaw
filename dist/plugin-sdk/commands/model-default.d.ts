import type { OpenClawConfig } from "../config/config.js";
import type { AgentModelListConfig } from "../config/types.js";
export declare function resolvePrimaryModel(model?: AgentModelListConfig | string): string | undefined;
export declare function applyAgentDefaultPrimaryModel(params: {
    cfg: OpenClawConfig;
    model: string;
    legacyModels?: Set<string>;
}): {
    next: OpenClawConfig;
    changed: boolean;
};
