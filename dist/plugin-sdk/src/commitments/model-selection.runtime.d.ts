import type { OpenClawConfig } from "../config/config.js";
export declare function resolveCommitmentDefaultModelRef(params: {
    cfg: OpenClawConfig;
    agentId?: string;
}): {
    provider: string;
    model: string;
};
