import type { OpenClawConfig } from "../../config/config.js";
import { type SessionEntry } from "../../config/sessions.js";
import type { TemplateContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import type { GetReplyOptions } from "../types.js";
import type { FollowupRun } from "./queue.js";
export declare function estimatePromptTokensForMemoryFlush(prompt?: string): number | undefined;
export declare function resolveEffectivePromptTokens(basePromptTokens?: number, lastOutputTokens?: number, promptTokenEstimate?: number): number;
export type SessionTranscriptUsageSnapshot = {
    promptTokens?: number;
    outputTokens?: number;
};
export declare function readPromptTokensFromSessionLog(sessionId?: string, sessionEntry?: SessionEntry, sessionKey?: string, opts?: {
    storePath?: string;
}): Promise<SessionTranscriptUsageSnapshot | undefined>;
export declare function runMemoryFlushIfNeeded(params: {
    cfg: OpenClawConfig;
    followupRun: FollowupRun;
    promptForEstimate?: string;
    sessionCtx: TemplateContext;
    opts?: GetReplyOptions;
    defaultModel: string;
    agentCfgContextTokens?: number;
    resolvedVerboseLevel: VerboseLevel;
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
    sessionKey?: string;
    storePath?: string;
    isHeartbeat: boolean;
}): Promise<SessionEntry | undefined>;
