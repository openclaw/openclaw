import type { OpenClawConfig } from "../../config/config.js";
export declare function resolveDefaultModelRef(cfg?: OpenClawConfig): {
    provider: string;
    model: string;
};
export declare function hasAuthForProvider(params: {
    provider: string;
    agentDir: string;
}): boolean;
