import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function applyAgentDefaultPrimaryModel(params: {
    cfg: OpenClawConfig;
    model: string;
    legacyModels?: Set<string>;
}): {
    next: OpenClawConfig;
    changed: boolean;
};
export declare function applyPrimaryModel(cfg: OpenClawConfig, model: string): OpenClawConfig;
