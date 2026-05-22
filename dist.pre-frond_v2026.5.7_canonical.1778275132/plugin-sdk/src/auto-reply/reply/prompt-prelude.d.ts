import type { MsgContext, TemplateContext } from "../templating.js";
export declare function buildReplyPromptBodies(params: {
    ctx: MsgContext;
    sessionCtx: TemplateContext;
    effectiveBaseBody: string;
    prefixedBody: string;
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
