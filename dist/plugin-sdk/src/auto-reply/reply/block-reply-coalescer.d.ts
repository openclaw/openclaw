import type { ReplyPayload } from "../types.js";
import type { BlockStreamingCoalescing } from "./block-streaming.js";
export type BlockReplyCoalescer = {
    enqueue: (payload: ReplyPayload) => void;
    flush: (options?: {
        force?: boolean;
    }) => Promise<void>;
    hasBuffered: () => boolean;
    stop: () => void;
};
export declare function createBlockReplyCoalescer(params: {
    config: BlockStreamingCoalescing;
    shouldAbort: () => boolean;
    onFlush: (payload: ReplyPayload) => Promise<void> | void;
}): BlockReplyCoalescer;
