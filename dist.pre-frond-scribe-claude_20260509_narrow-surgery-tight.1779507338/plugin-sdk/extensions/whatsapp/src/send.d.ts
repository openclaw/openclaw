import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { type PollInput } from "openclaw/plugin-sdk/poll-runtime";
export declare function sendMessageWhatsApp(to: string, body: string, options: {
    verbose: boolean;
    cfg: OpenClawConfig;
    mediaUrl?: string;
    mediaUrls?: readonly string[];
    mediaAccess?: {
        localRoots?: readonly string[];
        readFile?: (filePath: string) => Promise<Buffer>;
    };
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    mediaPayload?: {
        buffer: Buffer;
        contentType?: string;
        kind?: "image" | "audio" | "video" | "document";
        fileName?: string;
    };
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
}): Promise<{
    messageId: string;
    toJid: string;
}>;
export declare function sendTypingWhatsApp(to: string, options: {
    cfg: OpenClawConfig;
    accountId?: string;
}): Promise<void>;
export declare function sendReactionWhatsApp(chatJid: string, messageId: string, emoji: string, options: {
    verbose: boolean;
    fromMe?: boolean;
    participant?: string;
    accountId?: string;
    cfg: OpenClawConfig;
}): Promise<void>;
export declare function sendPollWhatsApp(to: string, poll: PollInput, options: {
    verbose: boolean;
    accountId?: string;
    cfg: OpenClawConfig;
}): Promise<{
    messageId: string;
    toJid: string;
}>;
