import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RetryConfig } from "openclaw/plugin-sdk/retry-runtime";
import type { RequestClient } from "./internal/discord.js";
import type { DiscordSendResult } from "./send.types.js";
type VoiceMessageOpts = {
    cfg: OpenClawConfig;
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
export declare function sendVoiceMessageDiscord(to: string, audioPath: string, opts: VoiceMessageOpts): Promise<DiscordSendResult>;
export {};
