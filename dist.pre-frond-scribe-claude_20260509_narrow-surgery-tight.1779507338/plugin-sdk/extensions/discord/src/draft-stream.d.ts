import { type RequestClient } from "./internal/discord.js";
type DiscordDraftStream = {
    update: (text: string) => void;
    flush: () => Promise<void>;
    messageId: () => string | undefined;
    clear: () => Promise<void>;
    discardPending: () => Promise<void>;
    seal: () => Promise<void>;
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
    suppressEmbeds?: boolean;
    log?: (message: string) => void;
    warn?: (message: string) => void;
}): DiscordDraftStream;
export {};
