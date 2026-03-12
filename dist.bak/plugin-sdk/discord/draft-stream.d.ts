import type { RequestClient } from "@buape/carbon";
export type DiscordDraftStream = {
    update: (text: string) => void;
    flush: () => Promise<void>;
    messageId: () => string | undefined;
    clear: () => Promise<void>;
    stop: () => Promise<void>;
    /** Reset internal state so the next update creates a new message instead of editing. */
    forceNewMessage: () => void;
};
export declare function createDiscordDraftStream(params: {
    rest: RequestClient;
    channelId: string;
    maxChars?: number;
    replyToMessageId?: string | (() => string | undefined);
    throttleMs?: number;
    /** Minimum chars before sending first message (debounce for push notifications) */
    minInitialChars?: number;
    log?: (message: string) => void;
    warn?: (message: string) => void;
}): DiscordDraftStream;
