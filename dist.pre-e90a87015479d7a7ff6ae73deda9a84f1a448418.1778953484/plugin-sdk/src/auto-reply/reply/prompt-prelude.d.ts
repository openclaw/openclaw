import type { CurrentTurnPromptContext } from "../../agents/pi-embedded-runner/run/params.js";
import type { MsgContext, TemplateContext } from "../templating.js";
export declare function buildReplyPromptBodies(params: {
    ctx: MsgContext;
    sessionCtx: TemplateContext;
    effectiveBaseBody: string;
    prefixedBody?: string;
    transcriptBody?: string;
    threadContextNote?: string;
    systemEventBlocks?: string[];
}): {
    mediaNote?: string;
    mediaReplyHint?: string;
    prefixedCommandBody: string;
    queuedBody: string;
    transcriptCommandBody: string;
};
export type ReplyPromptEnvelopeStartupAction = "new" | "reset";
export type ReplyPromptEnvelope = ReturnType<typeof buildReplyPromptBodies> & {
    /** Model-visible body before media, thread context, and inter-session annotation are applied. */
    effectiveBaseBody: string;
    /** User-visible body persisted to transcript before media/inter-session annotation. */
    transcriptBody: string;
    /** Runtime-only user context for backends that can carry it outside transcript text. */
    currentTurnContext?: CurrentTurnPromptContext;
};
export type ReplyPromptEnvelopeBase = {
    /** Model-visible body before media, thread context, and inter-session annotation are applied. */
    effectiveBaseBody: string;
    /** User-visible body persisted to transcript before media/inter-session annotation. */
    transcriptBody: string;
    /** Runtime-only user context for backends that can carry it outside transcript text. */
    currentTurnContext?: CurrentTurnPromptContext;
};
type ReplyPromptEnvelopeBaseParams = {
    ctx: MsgContext;
    sessionCtx: TemplateContext;
    baseBody: string;
    hasUserBody: boolean;
    inboundUserContext: string;
    inboundUserContextPromptJoiner?: CurrentTurnPromptContext["promptJoiner"];
    isBareSessionReset: boolean;
    startupAction: ReplyPromptEnvelopeStartupAction;
    startupContextPrelude?: string | null;
    softResetTail?: string;
    isHeartbeat?: boolean;
};
export declare function buildReplyPromptEnvelopeBase(params: ReplyPromptEnvelopeBaseParams): ReplyPromptEnvelopeBase;
export declare function buildReplyPromptEnvelope(params: ReplyPromptEnvelopeBaseParams & {
    prefixedBody?: string;
    threadContextNote?: string;
    systemEventBlocks?: string[];
}): ReplyPromptEnvelope;
export {};
