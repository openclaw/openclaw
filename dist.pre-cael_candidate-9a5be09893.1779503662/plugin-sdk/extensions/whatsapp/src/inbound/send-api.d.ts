import type { AnyMessageContent, MiscMessageGenerationOptions, WAMessage, WAPresence } from "baileys";
import { type WhatsAppOutboundMentionResolution } from "./outbound-mentions.js";
import { type WhatsAppSendResult } from "./send-result.js";
import type { ActiveWebSendOptions } from "./types.js";
export declare function createWebSendApi(params: {
    sock: {
        sendMessage: (jid: string, content: AnyMessageContent, options?: MiscMessageGenerationOptions) => Promise<WAMessage | undefined>;
        sendPresenceUpdate: (presence: WAPresence, jid?: string) => Promise<unknown>;
    };
    defaultAccountId: string;
    resolveOutboundMentions?: (params: {
        jid: string;
        text: string;
    }) => Promise<WhatsAppOutboundMentionResolution> | WhatsAppOutboundMentionResolution;
    authDir?: string;
}): {
    readonly sendMessage: (to: string, text: string, mediaBuffer?: Buffer, mediaType?: string, sendOptions?: ActiveWebSendOptions) => Promise<WhatsAppSendResult>;
    readonly sendPoll: (to: string, poll: {
        question: string;
        options: string[];
        maxSelections?: number;
    }) => Promise<WhatsAppSendResult>;
    readonly sendReaction: (chatJid: string, messageId: string, emoji: string, fromMe: boolean, participant?: string) => Promise<WhatsAppSendResult>;
    readonly sendComposingTo: (to: string) => Promise<void>;
};
