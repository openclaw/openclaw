import type { CoreConfig } from "./types.js";
export declare function sendQaChannelText(params: {
    cfg: CoreConfig;
    accountId?: string | null;
    to: string;
    text: string;
    threadId?: string | number | null;
    replyToId?: string | number | null;
}): Promise<{
    to: string;
    messageId: string;
}>;
