import type { PollInput } from "../polls.js";
export type ActiveWebSendOptions = {
    gifPlayback?: boolean;
    accountId?: string;
    fileName?: string;
};
export type ActiveWebListener = {
    sendMessage: (to: string, text: string, mediaBuffer?: Buffer, mediaType?: string, options?: ActiveWebSendOptions) => Promise<{
        messageId: string;
    }>;
    sendPoll: (to: string, poll: PollInput) => Promise<{
        messageId: string;
    }>;
    sendReaction: (chatJid: string, messageId: string, emoji: string, fromMe: boolean, participant?: string) => Promise<void>;
    sendComposingTo: (to: string) => Promise<void>;
    close?: () => Promise<void>;
};
export declare function resolveWebAccountId(accountId?: string | null): string;
export declare function requireActiveWebListener(accountId?: string | null): {
    accountId: string;
    listener: ActiveWebListener;
};
export declare function setActiveWebListener(listener: ActiveWebListener | null): void;
export declare function setActiveWebListener(accountId: string | null | undefined, listener: ActiveWebListener | null): void;
export declare function getActiveWebListener(accountId?: string | null): ActiveWebListener | null;
