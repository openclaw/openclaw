/**
 * Discord Voice Message Support
 *
 * Implements sending voice messages via Discord's API.
 * Voice messages require:
 * - OGG/Opus format audio
 * - Waveform data (base64 encoded, up to 256 samples, 0-255 values)
 * - Duration in seconds
 * - Message flag 8192 (IS_VOICE_MESSAGE)
 * - No other content (text, embeds, etc.)
 */
import type { RequestClient } from "@buape/carbon";
import type { RetryRunner } from "../infra/retry-policy.js";
export type VoiceMessageMetadata = {
    durationSecs: number;
    waveform: string;
};
/**
 * Get audio duration using ffprobe
 */
export declare function getAudioDuration(filePath: string): Promise<number>;
/**
 * Generate waveform data from audio file using ffmpeg
 * Returns base64 encoded byte array of amplitude samples (0-255)
 */
export declare function generateWaveform(filePath: string): Promise<string>;
/**
 * Convert audio file to OGG/Opus format if needed
 * Returns path to the OGG file (may be same as input if already OGG/Opus)
 */
export declare function ensureOggOpus(filePath: string): Promise<{
    path: string;
    cleanup: boolean;
}>;
/**
 * Get voice message metadata (duration and waveform)
 */
export declare function getVoiceMessageMetadata(filePath: string): Promise<VoiceMessageMetadata>;
/**
 * Send a voice message to Discord
 *
 * This follows Discord's voice message protocol:
 * 1. Request upload URL from Discord
 * 2. Upload the OGG file to the provided URL
 * 3. Send the message with flag 8192 and attachment metadata
 */
export declare function sendDiscordVoiceMessage(rest: RequestClient, channelId: string, audioBuffer: Buffer, metadata: VoiceMessageMetadata, replyTo: string | undefined, request: RetryRunner, silent?: boolean): Promise<{
    id: string;
    channel_id: string;
}>;
