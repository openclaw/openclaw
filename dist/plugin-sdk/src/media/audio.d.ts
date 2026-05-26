export declare const VOICE_MESSAGE_AUDIO_EXTENSIONS: Set<string>;
/**
 * MIME types compatible with voice messages.
 */
export declare const VOICE_MESSAGE_MIME_TYPES: Set<string>;
export declare function isVoiceMessageCompatibleAudio(opts: {
    contentType?: string | null;
    fileName?: string | null;
}): boolean;
export declare function isVoiceCompatibleAudio(opts: {
    contentType?: string | null;
    fileName?: string | null;
}): boolean;
