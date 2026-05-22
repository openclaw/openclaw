import type { EmbeddedPiCompactResult } from "../../agents/pi-embedded-runner/types.js";
import { type SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TemplateContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { type BlockReplyPipeline } from "./block-reply-pipeline.js";
import type { FollowupRun } from "./queue.js";
import type { ReplyMediaContext } from "./reply-media-paths.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import type { TypingSignaler } from "./typing-mode.js";
type EmbeddedAgentRunResult = Awaited<ReturnType<typeof import("../../agents/pi-embedded.runtime.js").runEmbeddedPiAgent>>;
export declare const MAX_LIVE_SWITCH_RETRIES = 2;
export declare function releaseQueuedCompactionCompletion(params: {
    activeSessionStore?: Record<string, SessionEntry>;
    compactionResult: EmbeddedPiCompactResult;
    followupRun: FollowupRun;
    getActiveSessionEntry: () => SessionEntry | undefined;
    sessionKey?: string;
    storePath?: string;
    traceparent?: string;
}): Promise<void>;
export type RuntimeFallbackAttempt = {
    provider: string;
    model: string;
    error: string;
    reason?: string;
    status?: number;
    code?: string;
};
export type AgentRunLoopResult = {
    kind: "success";
    runId: string;
    runResult: EmbeddedAgentRunResult;
    fallbackProvider?: string;
    fallbackModel?: string;
    fallbackAttempts: RuntimeFallbackAttempt[];
    didLogHeartbeatStrip: boolean;
    autoCompactionCount: number;
    compactionTraceparent?: string;
    /** Payload keys sent directly (not via pipeline) during tool flush. */
    continueWorkRequest?: import("../../agents/tools/continue-work-tool.js").ContinueWorkRequest;
    directlySentBlockKeys?: Set<string>;
} | {
    kind: "final";
    payload: ReplyPayload;
};
type FallbackSelectionState = Pick<SessionEntry, "providerOverride" | "modelOverride" | "modelOverrideSource" | "modelOverrideFallbackOriginProvider" | "modelOverrideFallbackOriginModel" | "authProfileOverride" | "authProfileOverrideSource" | "authProfileOverrideCompactionCount">;
export declare function applyFallbackCandidateSelectionToEntry(params: {
    entry: SessionEntry;
    run: FollowupRun["run"];
    provider: string;
    model: string;
    origin?: {
        provider: string;
        model: string;
    };
    force?: boolean;
    now?: number;
}): {
    updated: boolean;
    nextState?: FallbackSelectionState;
};
export declare function buildKnownAgentRunFailureReplyPayload(params: {
    err: unknown;
    sessionCtx: TemplateContext;
    resolvedVerboseLevel: VerboseLevel | undefined;
    cfg?: OpenClawConfig;
}): ReplyPayload | undefined;
export declare function buildContextOverflowRecoveryText(params: {
    duringCompaction?: boolean;
    preserveSessionMapping?: boolean;
    cfg: FollowupRun["run"]["config"];
    agentId?: string;
    primaryProvider?: string;
    primaryModel?: string;
    activeSessionEntry?: SessionEntry;
}): string;
export declare function resolveSessionRuntimeOverrideForProvider(params: {
    provider: string;
    entry?: Pick<SessionEntry, "agentRuntimeOverride">;
}): string | undefined;
export declare function resolveRunAfterAutoFallbackPrimaryProbeRecheck(params: {
    run: FollowupRun["run"];
    entry?: SessionEntry;
    sessionKey?: string;
}): FollowupRun["run"];
export declare function runAgentTurnWithFallback(params: {
    commandBody: string;
    transcriptCommandBody?: string;
    followupRun: FollowupRun;
    sessionCtx: TemplateContext;
    replyThreading?: TemplateContext["ReplyThreading"];
    replyOperation?: ReplyOperation;
    opts?: GetReplyOptions;
    typingSignals: TypingSignaler;
    blockReplyPipeline: BlockReplyPipeline | null;
    blockStreamingEnabled: boolean;
    blockReplyChunking?: {
        minChars: number;
        maxChars: number;
        breakPreference: "paragraph" | "newline" | "sentence";
        flushOnParagraph?: boolean;
    };
    resolvedBlockStreamingBreak: "text_end" | "message_end";
    applyReplyToMode: (payload: ReplyPayload) => ReplyPayload;
    shouldEmitToolResult: () => boolean;
    shouldEmitToolOutput: () => boolean;
    pendingToolTasks: Set<Promise<void>>;
    resetSessionAfterCompactionFailure: (reason: string) => Promise<boolean>;
    resetSessionAfterRoleOrderingConflict: (reason: string) => Promise<boolean>;
    isHeartbeat: boolean;
    sessionKey?: string;
    runtimePolicySessionKey?: string;
    getActiveSessionEntry: () => SessionEntry | undefined;
    activeSessionStore?: Record<string, SessionEntry>;
    storePath?: string;
    resolvedVerboseLevel: VerboseLevel;
    toolProgressDetail?: "explain" | "raw";
    replyMediaContext?: ReplyMediaContext;
}): Promise<AgentRunLoopResult>;
export {};
