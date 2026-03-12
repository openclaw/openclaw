import type { ReplyDirectiveParseResult } from "./reply-directives.js";
type ConsumeOptions = {
    final?: boolean;
    silentToken?: string;
};
export declare function createStreamingDirectiveAccumulator(): {
    consume: (raw: string, options?: ConsumeOptions) => ReplyDirectiveParseResult | null;
    reset: () => void;
};
export {};
