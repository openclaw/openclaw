import type { WASocket } from "baileys";
import type { OpenClawConfig } from "../runtime-api.js";
import type { WebInboundMessage, WebListenerCloseReason } from "./types.js";
export declare const WHATSAPP_GROUP_METADATA_CACHE_MAX_ENTRIES = 500;
type WhatsAppGroupMetadataCacheEntry = {
    subject?: string;
    expires: number;
};
export type WhatsAppGroupMetadataCache = Map<string, WhatsAppGroupMetadataCacheEntry>;
type MonitorWebInboxOptions = {
    cfg: OpenClawConfig;
    loadConfig?: () => OpenClawConfig;
    verbose: boolean;
    accountId: string;
    authDir: string;
    onMessage: (msg: WebInboundMessage) => Promise<void>;
    mediaMaxMb?: number;
    /** Keep the global presence unavailable so self-chat sessions do not mute phone pushes. */
    selfChatMode?: boolean;
    /** Send read receipts for incoming messages (default true). */
    sendReadReceipts?: boolean;
    /** Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable). */
    debounceMs?: number;
    /** Optional debounce gating predicate. */
    shouldDebounce?: (msg: WebInboundMessage) => boolean;
    /** Optional shared socket reference so reply closures can follow reconnects. */
    socketRef?: {
        current: WASocket | null;
    };
    /** Whether send retries should wait for a reconnect. */
    shouldRetryDisconnect?: () => boolean;
    /** Reconnect timing for waiting through transient socket replacement gaps. */
    disconnectRetryPolicy?: {
        initialMs: number;
        maxMs: number;
        factor: number;
        jitter: number;
        maxAttempts: number;
    };
    /** Abort in-flight reconnect waits when shutdown becomes terminal. */
    disconnectRetryAbortSignal?: AbortSignal;
    /** Shared group metadata cache used only for inbound metadata fallback after fetch failures. */
    groupMetadataCache?: WhatsAppGroupMetadataCache;
};
export declare function attachWebInboxToSocket(options: MonitorWebInboxOptions & {
    sock: WASocket;
}): Promise<{
    readonly sendMessage: (to: string, text: string, mediaBuffer?: Buffer, mediaType?: string, sendOptions?: import("./types.js").ActiveWebSendOptions) => Promise<import("./send-result.js").WhatsAppSendResult>;
    readonly sendPoll: (to: string, poll: {
        question: string;
        options: string[];
        maxSelections?: number;
    }) => Promise<import("./send-result.js").WhatsAppSendResult>;
    readonly sendReaction: (chatJid: string, messageId: string, emoji: string, fromMe: boolean, participant?: string) => Promise<import("./send-result.js").WhatsAppSendResult>;
    readonly sendComposingTo: (to: string) => Promise<void>;
    readonly close: () => Promise<void>;
    readonly onClose: Promise<WebListenerCloseReason>;
    readonly signalClose: (reason?: WebListenerCloseReason) => void;
}>;
export declare function monitorWebInbox(options: MonitorWebInboxOptions): Promise<{
    readonly sendMessage: (to: string, text: string, mediaBuffer?: Buffer, mediaType?: string, sendOptions?: import("./types.js").ActiveWebSendOptions) => Promise<import("./send-result.js").WhatsAppSendResult>;
    readonly sendPoll: (to: string, poll: {
        question: string;
        options: string[];
        maxSelections?: number;
    }) => Promise<import("./send-result.js").WhatsAppSendResult>;
    readonly sendReaction: (chatJid: string, messageId: string, emoji: string, fromMe: boolean, participant?: string) => Promise<import("./send-result.js").WhatsAppSendResult>;
    readonly sendComposingTo: (to: string) => Promise<void>;
    readonly close: () => Promise<void>;
    readonly onClose: Promise<WebListenerCloseReason>;
    readonly signalClose: (reason?: WebListenerCloseReason) => void;
}>;
export {};
