import { type NormalizedUsage } from "../../agents/usage.js";
import { type SessionSystemPromptReport } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
export declare function persistSessionUsageUpdate(params: {
    storePath?: string;
    sessionKey?: string;
    cfg?: OpenClawConfig;
    usage?: NormalizedUsage;
    /**
     * Usage from the last individual API call (not accumulated). When provided,
     * this is used for `totalTokens` instead of the accumulated `usage` so that
     * context-window utilization reflects the actual current context size rather
     * than the sum of input tokens across all API calls in the run.
     */
    lastCallUsage?: NormalizedUsage;
    modelUsed?: string;
    providerUsed?: string;
    contextTokensUsed?: number;
    promptTokens?: number;
    usageIsContextSnapshot?: boolean;
    systemPromptReport?: SessionSystemPromptReport;
    cliSessionId?: string;
    cliSessionBinding?: import("../../config/sessions.js").CliSessionBinding;
    logLabel?: string;
}): Promise<void>;
