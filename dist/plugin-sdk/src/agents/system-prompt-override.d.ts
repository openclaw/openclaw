import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function resolveSystemPromptOverride(params: {
    config?: OpenClawConfig;
    agentId?: string;
}): string | undefined;
