import type { ReplyPayload } from "../types.js";
import type { BlockStreamingCoalescing } from "./block-streaming.js";
export type BlockReplyPipeline = {
    enqueue: (payload: ReplyPayload) => void;
    flush: (options?: {
        force?: boolean;
    }) => Promise<void>;
    stop: () => void;
    hasBuffered: () => boolean;
    didStream: () => boolean;
    isAborted: () => boolean;
    hasSentPayload: (payload: ReplyPayload) => boolean;
};
export type BlockReplyBuffer = {
    shouldBuffer: (payload: ReplyPayload) => boolean;
    onEnqueue?: (payload: ReplyPayload) => void;
    finalize?: (payload: ReplyPayload) => ReplyPayload;
};
export declare function createAudioAsVoiceBuffer(params: {
    isAudioPayload: (payload: ReplyPayload) => boolean;
}): BlockReplyBuffer;
export declare function createBlockReplyPayloadKey(payload: ReplyPayload): string;
export declare function createBlockReplyPipeline(params: {
    onBlockReply: (payload: ReplyPayload, options?: {
        abortSignal?: AbortSignal;
        timeoutMs?: number;
    }) => Promise<void> | void;
    timeoutMs: number;
    coalescing?: BlockStreamingCoalescing;
    buffer?: BlockReplyBuffer;
}): BlockReplyPipeline;
