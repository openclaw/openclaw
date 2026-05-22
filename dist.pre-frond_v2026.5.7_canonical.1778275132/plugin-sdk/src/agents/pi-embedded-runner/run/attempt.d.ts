import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { EmbeddedContextFile } from "../../pi-embedded-helpers.js";
import { resetEmbeddedAgentBaseStreamFnCacheForTest, resolveEmbeddedAgentBaseStreamFn, resolveEmbeddedAgentStreamFn } from "../stream-resolution.js";
export { buildContextEnginePromptCacheInfo } from "./attempt.context-engine-helpers.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";
export { appendAttemptCacheTtlIfNeeded, composeSystemPromptWithHookContext, resolveAttemptSpawnWorkspaceDir, } from "./attempt.thread-helpers.js";
export { buildAfterTurnRuntimeContext, buildAfterTurnRuntimeContextFromUsage, mergeOrphanedTrailingUserPrompt, prependSystemPromptAddition, resolveAttemptFsWorkspaceOnly, resolveAttemptPrependSystemContext, resolvePromptBuildHookResult, resolvePromptModeForSession, shouldWarnOnOrphanedUserRepair, shouldInjectHeartbeatPrompt, } from "./attempt.prompt-helpers.js";
export { persistSessionsYieldContextMessage, queueSessionsYieldInterruptMessage, stripSessionsYieldArtifacts, } from "./attempt.sessions-yield.js";
export { decodeHtmlEntitiesInObject, wrapStreamFnRepairMalformedToolCallArguments, } from "./attempt.tool-call-argument-repair.js";
export { wrapStreamFnSanitizeMalformedToolCalls, wrapStreamFnTrimToolCallNames, } from "./attempt.tool-call-normalization.js";
export { resetEmbeddedAgentBaseStreamFnCacheForTest, resolveEmbeddedAgentBaseStreamFn, resolveEmbeddedAgentStreamFn, };
export declare function resolveUnknownToolGuardThreshold(loopDetection?: {
    enabled?: boolean;
    unknownToolThreshold?: number;
}): number;
export declare function isPrimaryBootstrapRun(sessionKey?: string): boolean;
export declare function remapInjectedContextFilesToWorkspace(params: {
    files: EmbeddedContextFile[];
    sourceWorkspaceDir: string;
    targetWorkspaceDir: string;
}): EmbeddedContextFile[];
export declare function normalizeMessagesForLlmBoundary(messages: AgentMessage[]): AgentMessage[];
export declare function resolveAttemptToolPolicyMessageProvider(params: {
    messageProvider?: string;
    messageChannel?: string;
}): string | undefined;
export declare function runEmbeddedAttempt(params: EmbeddedRunAttemptParams): Promise<EmbeddedRunAttemptResult>;
