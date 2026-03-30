import type { WebInboundMessage, WebListenerCloseReason } from "./types.js";
export declare function monitorWebInbox(options: {
    verbose: boolean;
    accountId: string;
    authDir: string;
    onMessage: (msg: WebInboundMessage) => Promise<void>;
    mediaMaxMb?: number;
    /** Send read receipts for incoming messages (default true). */
    sendReadReceipts?: boolean;
    /** Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable). */
    debounceMs?: number;
    /** Optional debounce gating predicate. */
    shouldDebounce?: (msg: WebInboundMessage) => boolean;
}): Promise<{
    readonly sendMessage: (to: string, text: string, mediaBuffer?: Buffer, mediaType?: string, sendOptions?: import("../active-listener.ts").ActiveWebSendOptions) => Promise<{
        messageId: string;
    }>;
    readonly sendPoll: (to: string, poll: {
        question: string;
        options: string[];
        maxSelections?: number;
    }) => Promise<{
        messageId: string;
    }>;
    readonly sendReaction: (chatJid: string, messageId: string, emoji: string, fromMe: boolean, participant?: string) => Promise<void>;
    readonly sendComposingTo: (to: string) => Promise<void>;
    readonly close: () => Promise<void>;
    readonly onClose: Promise<WebListenerCloseReason>;
    readonly signalClose: (reason?: WebListenerCloseReason) => void;
}>;
