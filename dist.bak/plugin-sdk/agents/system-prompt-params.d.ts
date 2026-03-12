import type { OpenClawConfig } from "../config/config.js";
import { type ResolvedTimeFormat } from "./date-time.js";
export type RuntimeInfoInput = {
    agentId?: string;
    host: string;
    os: string;
    arch: string;
    node: string;
    model: string;
    defaultModel?: string;
    shell?: string;
    channel?: string;
    capabilities?: string[];
    /** Supported message actions for the current channel (e.g., react, edit, unsend) */
    channelActions?: string[];
    repoRoot?: string;
};
export type SystemPromptRuntimeParams = {
    runtimeInfo: RuntimeInfoInput;
    userTimezone: string;
    userTime?: string;
    userTimeFormat?: ResolvedTimeFormat;
};
export declare function buildSystemPromptParams(params: {
    config?: OpenClawConfig;
    agentId?: string;
    runtime: Omit<RuntimeInfoInput, "agentId">;
    workspaceDir?: string;
    cwd?: string;
}): SystemPromptRuntimeParams;
