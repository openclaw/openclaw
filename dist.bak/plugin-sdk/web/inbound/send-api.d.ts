import type { AnyMessageContent, WAPresence } from "@whiskeysockets/baileys";
import type { ActiveWebSendOptions } from "../active-listener.js";
export declare function createWebSendApi(params: {
    sock: {
        sendMessage: (jid: string, content: AnyMessageContent) => Promise<unknown>;
        sendPresenceUpdate: (presence: WAPresence, jid?: string) => Promise<unknown>;
    };
    defaultAccountId: string;
}): {
    readonly sendMessage: (to: string, text: string, mediaBuffer?: Buffer, mediaType?: string, sendOptions?: ActiveWebSendOptions) => Promise<{
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
};
