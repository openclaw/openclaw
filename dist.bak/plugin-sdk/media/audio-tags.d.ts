/**
 * Extract audio mode tag from text.
 * Supports [[audio_as_voice]] to send audio as voice bubble instead of file.
 * Default is file (preserves backward compatibility).
 */
export declare function parseAudioTag(text?: string): {
    text: string;
    audioAsVoice: boolean;
    hadTag: boolean;
};
