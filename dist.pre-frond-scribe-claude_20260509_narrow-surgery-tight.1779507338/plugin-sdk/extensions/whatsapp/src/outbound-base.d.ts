import { type ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
type WhatsAppChunker = NonNullable<ChannelOutboundAdapter["chunker"]>;
type WhatsAppSendTextOptions = {
    verbose: boolean;
    cfg: OpenClawConfig;
    mediaUrl?: string;
    mediaAccess?: {
        localRoots?: readonly string[];
        readFile?: (filePath: string) => Promise<Buffer>;
    };
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    gifPlayback?: boolean;
    audioAsVoice?: boolean;
    forceDocument?: boolean;
    accountId?: string;
    quotedMessageKey?: {
        id: string;
        remoteJid: string;
        fromMe: boolean;
        participant?: string;
        messageText?: string;
    };
    preserveLeadingWhitespace?: boolean;
};
type WhatsAppSendMessage = (to: string, body: string, options: WhatsAppSendTextOptions) => Promise<{
    messageId: string;
    toJid: string;
}>;
type WhatsAppSendPoll = (to: string, poll: Parameters<NonNullable<ChannelOutboundAdapter["sendPoll"]>>[0]["poll"], options: {
    verbose: boolean;
    accountId?: string;
    cfg: OpenClawConfig;
}) => Promise<{
    messageId: string;
    toJid: string;
}>;
type CreateWhatsAppOutboundBaseParams = {
    chunker: WhatsAppChunker;
    sendMessageWhatsApp: WhatsAppSendMessage;
    sendPollWhatsApp: WhatsAppSendPoll;
    shouldLogVerbose: () => boolean;
    resolveTarget: ChannelOutboundAdapter["resolveTarget"];
    normalizeText?: (text: string | undefined) => string;
    skipEmptyText?: boolean;
};
export declare function createWhatsAppOutboundBase({ chunker, sendMessageWhatsApp, sendPollWhatsApp, shouldLogVerbose, resolveTarget, normalizeText, skipEmptyText, }: CreateWhatsAppOutboundBaseParams): Pick<ChannelOutboundAdapter, "deliveryMode" | "chunker" | "chunkerMode" | "textChunkLimit" | "sanitizeText" | "deliveryCapabilities" | "pollMaxOptions" | "resolveTarget" | "sendPayload" | "sendText" | "sendMedia" | "sendPoll">;
export {};
