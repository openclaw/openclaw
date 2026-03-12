import type { BlockReplyContext, ReplyPayload } from "../types.js";
import type { BlockReplyPipeline } from "./block-reply-pipeline.js";
import type { TypingSignaler } from "./typing-mode.js";
export type ReplyDirectiveParseMode = "always" | "auto" | "never";
export declare function normalizeReplyPayloadDirectives(params: {
    payload: ReplyPayload;
    currentMessageId?: string;
    silentToken?: string;
    trimLeadingWhitespace?: boolean;
    parseMode?: ReplyDirectiveParseMode;
}): {
    payload: ReplyPayload;
    isSilent: boolean;
};
export declare function createBlockReplyDeliveryHandler(params: {
    onBlockReply: (payload: ReplyPayload, context?: BlockReplyContext) => Promise<void> | void;
    currentMessageId?: string;
    normalizeStreamingText: (payload: ReplyPayload) => {
        text?: string;
        skip: boolean;
    };
    applyReplyToMode: (payload: ReplyPayload) => ReplyPayload;
    typingSignals: TypingSignaler;
    blockStreamingEnabled: boolean;
    blockReplyPipeline: BlockReplyPipeline | null;
    directlySentBlockKeys: Set<string>;
}): (payload: ReplyPayload) => Promise<void>;
