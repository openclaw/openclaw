import { type SessionEntry } from "../../config/sessions.js";
import type { TypingMode } from "../../config/types.js";
import type { TemplateContext } from "../templating.js";
import { type VerboseLevel } from "../thinking.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { type FollowupRun, type QueueSettings } from "./queue.js";
import { type ReplyOperation } from "./reply-run-registry.js";
import type { TypingController } from "./typing.js";
/**
 * Cancel any pending continuation timer for the given session AND reset
 * chain metadata. Call this from early-return paths (inline actions, slash
 * commands, directive replies) that bypass runReplyAgent but still represent
 * real user input that should preempt a running continuation chain.
 */
export declare function cancelContinuationTimer(sessionKey: string, sessionCtx?: {
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
    storePath?: string;
}): void;
export declare function runReplyAgent(params: {
    commandBody: string;
    transcriptCommandBody?: string;
    followupRun: FollowupRun;
    queueKey: string;
    resolvedQueue: QueueSettings;
    shouldSteer: boolean;
    shouldFollowup: boolean;
    isActive: boolean;
    isRunActive?: () => boolean;
    isStreaming: boolean;
    opts?: GetReplyOptions;
    typing: TypingController;
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
    sessionKey?: string;
    runtimePolicySessionKey?: string;
    storePath?: string;
    defaultModel: string;
    agentCfgContextTokens?: number;
    resolvedVerboseLevel: VerboseLevel;
    isNewSession: boolean;
    blockStreamingEnabled: boolean;
    blockReplyChunking?: {
        minChars: number;
        maxChars: number;
        breakPreference: "paragraph" | "newline" | "sentence";
        flushOnParagraph?: boolean;
    };
    resolvedBlockStreamingBreak: "text_end" | "message_end";
    sessionCtx: TemplateContext;
    shouldInjectGroupIntro: boolean;
    typingMode: TypingMode;
    /** True when this turn was triggered by a continuation timer (detected before system events are drained). */
    isContinuationWake?: boolean;
    resetTriggered?: boolean;
    replyThreadingOverride?: TemplateContext["ReplyThreading"];
    replyOperation?: ReplyOperation;
}): Promise<ReplyPayload | ReplyPayload[] | undefined>;
