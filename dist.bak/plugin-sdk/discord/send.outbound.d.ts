import { type RequestClient } from "@buape/carbon";
import type { RetryConfig } from "../infra/retry.js";
import type { PollInput } from "../polls.js";
import { type DiscordSendComponents, type DiscordSendEmbeds } from "./send.shared.js";
import type { DiscordSendResult } from "./send.types.js";
type DiscordSendOpts = {
    token?: string;
    accountId?: string;
    mediaUrl?: string;
    mediaLocalRoots?: readonly string[];
    verbose?: boolean;
    rest?: RequestClient;
    replyTo?: string;
    retry?: RetryConfig;
    components?: DiscordSendComponents;
    embeds?: DiscordSendEmbeds;
    silent?: boolean;
};
export declare function sendMessageDiscord(to: string, text: string, opts?: DiscordSendOpts): Promise<DiscordSendResult>;
type DiscordWebhookSendOpts = {
    webhookId: string;
    webhookToken: string;
    accountId?: string;
    threadId?: string | number;
    replyTo?: string;
    username?: string;
    avatarUrl?: string;
    wait?: boolean;
};
export declare function sendWebhookMessageDiscord(text: string, opts: DiscordWebhookSendOpts): Promise<DiscordSendResult>;
export declare function sendStickerDiscord(to: string, stickerIds: string[], opts?: DiscordSendOpts & {
    content?: string;
}): Promise<DiscordSendResult>;
export declare function sendPollDiscord(to: string, poll: PollInput, opts?: DiscordSendOpts & {
    content?: string;
}): Promise<DiscordSendResult>;
type VoiceMessageOpts = {
    token?: string;
    accountId?: string;
    verbose?: boolean;
    rest?: RequestClient;
    replyTo?: string;
    retry?: RetryConfig;
    silent?: boolean;
};
/**
 * Send a voice message to Discord.
 *
 * Voice messages are a special Discord feature that displays audio with a waveform
 * visualization. They require OGG/Opus format and cannot include text content.
 *
 * @param to - Recipient (user ID for DM or channel ID)
 * @param audioPath - Path to local audio file (will be converted to OGG/Opus if needed)
 * @param opts - Send options
 */
export declare function sendVoiceMessageDiscord(to: string, audioPath: string, opts?: VoiceMessageOpts): Promise<DiscordSendResult>;
export {};
