import { type PollInput } from "../polls.js";
export declare function sendMessageWhatsApp(to: string, body: string, options: {
    verbose: boolean;
    mediaUrl?: string;
    mediaLocalRoots?: readonly string[];
    gifPlayback?: boolean;
    accountId?: string;
}): Promise<{
    messageId: string;
    toJid: string;
}>;
export declare function sendReactionWhatsApp(chatJid: string, messageId: string, emoji: string, options: {
    verbose: boolean;
    fromMe?: boolean;
    participant?: string;
    accountId?: string;
}): Promise<void>;
export declare function sendPollWhatsApp(to: string, poll: PollInput, options: {
    verbose: boolean;
    accountId?: string;
}): Promise<{
    messageId: string;
    toJid: string;
}>;
