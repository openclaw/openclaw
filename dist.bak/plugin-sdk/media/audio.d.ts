export declare const TELEGRAM_VOICE_AUDIO_EXTENSIONS: Set<string>;
/**
 * MIME types compatible with voice messages.
 * Telegram sendVoice supports OGG/Opus, MP3, and M4A.
 * https://core.telegram.org/bots/api#sendvoice
 */
export declare const TELEGRAM_VOICE_MIME_TYPES: Set<string>;
export declare function isTelegramVoiceCompatibleAudio(opts: {
    contentType?: string | null;
    fileName?: string | null;
}): boolean;
/**
 * Backward-compatible alias used across plugin/runtime call sites.
 * Keeps existing behavior while making Telegram-specific policy explicit.
 */
export declare function isVoiceCompatibleAudio(opts: {
    contentType?: string | null;
    fileName?: string | null;
}): boolean;
