import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { EmbeddedContextFile } from "../../pi-embedded-helpers.js";
import { resetEmbeddedAgentBaseStreamFnCacheForTest, resolveEmbeddedAgentBaseStreamFn, resolveEmbeddedAgentStreamFn } from "../stream-resolution.js";
import { collectAllowedToolNames } from "../tool-name-allowlist.js";
export { buildContextEnginePromptCacheInfo } from "./attempt.context-engine-helpers.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";
export { appendAttemptCacheTtlIfNeeded, composeSystemPromptWithHookContext, resolveAttemptSpawnWorkspaceDir, } from "./attempt.thread-helpers.js";
export { buildAfterTurnRuntimeContext, buildAfterTurnRuntimeContextFromUsage, mergeOrphanedTrailingUserPrompt, prependSystemPromptAddition, resolveAttemptFsWorkspaceOnly, resolveAttemptPrependSystemContext, resolvePromptBuildHookResult, resolvePromptModeForSession, shouldWarnOnOrphanedUserRepair, shouldInjectHeartbeatPrompt, } from "./attempt.prompt-helpers.js";
export { persistSessionsYieldContextMessage, queueSessionsYieldInterruptMessage, stripSessionsYieldArtifacts, } from "./attempt.sessions-yield.js";
export { decodeHtmlEntitiesInObject, wrapStreamFnRepairMalformedToolCallArguments, } from "./attempt.tool-call-argument-repair.js";
export { wrapStreamFnSanitizeMalformedToolCalls, wrapStreamFnTrimToolCallNames, } from "./attempt.tool-call-normalization.js";
export { resetEmbeddedAgentBaseStreamFnCacheForTest, resolveEmbeddedAgentBaseStreamFn, resolveEmbeddedAgentStreamFn, };
export declare function buildCallableToolNamesForEmptyAllowlistCheck(params: {
    effectiveToolNames: string[];
    autoAddedToolSearchControlNames?: Set<string>;
    toolSearchCatalogToolCount: number;
}): string[];
export declare function buildAutoAddedToolSearchControlNamesForAllowlistCheck(params: {
    toolSearchControlsEnabled: boolean;
    explicitAllowlistSources: Array<{
        entries: string[];
    }>;
    controlNames?: readonly string[];
}): Set<string> | undefined;
export type ToolSearchRunPlan = {
    visibleAllowedToolNames: Set<string>;
    replayAllowedToolNames: Set<string>;
    autoAddedControlNames?: Set<string>;
    emptyAllowlistCallableNames: string[];
};
type CollectAllowedToolNamesParams = Parameters<typeof collectAllowedToolNames>[0];
export declare function buildToolSearchRunPlan(params: {
    visibleTools: CollectAllowedToolNamesParams["tools"];
    uncompactedTools: CollectAllowedToolNamesParams["tools"];
    clientTools?: CollectAllowedToolNamesParams["clientTools"];
    catalogRegistered: boolean;
    catalogToolCount: number;
    controlsEnabled: boolean;
    explicitAllowlistSources: Array<{
        entries: string[];
    }>;
}): ToolSearchRunPlan;
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
export declare function shouldRunLlmOutputHooksForAttempt(params: {
    promptErrorSource: string | null;
}): boolean;
export declare function resolveAttemptToolPolicyMessageProvider(params: {
    messageProvider?: string;
    messageChannel?: string;
}): string | undefined;
export declare function runEmbeddedAttempt(params: EmbeddedRunAttemptParams): Promise<EmbeddedRunAttemptResult>;
