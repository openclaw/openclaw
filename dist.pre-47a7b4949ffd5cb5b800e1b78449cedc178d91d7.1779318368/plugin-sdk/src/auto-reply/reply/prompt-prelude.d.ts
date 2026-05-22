import type { CurrentInboundPromptContext } from "../../agents/pi-embedded-runner/run/params.js";
import type { InboundEventKind } from "../../channels/inbound-event/kind.js";
import type { MsgContext, TemplateContext } from "../templating.js";
export declare function buildReplyPromptBodies(params: {
    ctx: MsgContext;
    sessionCtx: TemplateContext;
    effectiveBaseBody: string;
    prefixedBody?: string;
    transcriptBody?: string;
    threadContextNote?: string;
    systemEventBlocks?: string[];
    inboundEventKind?: InboundEventKind;
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
    currentInboundContext?: CurrentInboundPromptContext;
};
export type ReplyPromptEnvelopeBase = {
    /** Model-visible body before media, thread context, and inter-session annotation are applied. */
    effectiveBaseBody: string;
    /** User-visible body persisted to transcript before media/inter-session annotation. */
    transcriptBody: string;
    /** Runtime-only user context for backends that can carry it outside transcript text. */
    currentInboundContext?: CurrentInboundPromptContext;
};
type ReplyPromptEnvelopeBaseParams = {
    ctx: MsgContext;
    sessionCtx: TemplateContext;
    baseBody: string;
    hasUserBody: boolean;
    inboundUserContext: string;
    inboundUserContextPromptJoiner?: CurrentInboundPromptContext["promptJoiner"];
    isBareSessionReset: boolean;
    startupAction: ReplyPromptEnvelopeStartupAction;
    startupContextPrelude?: string | null;
    softResetTail?: string;
    isHeartbeat?: boolean;
    inboundEventKind?: InboundEventKind;
};
export declare function buildReplyPromptEnvelopeBase(params: ReplyPromptEnvelopeBaseParams): ReplyPromptEnvelopeBase;
export declare function buildReplyPromptEnvelope(params: ReplyPromptEnvelopeBaseParams & {
    prefixedBody?: string;
    threadContextNote?: string;
    systemEventBlocks?: string[];
}): ReplyPromptEnvelope;
export {};
