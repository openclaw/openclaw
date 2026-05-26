//#region src/media/audio.d.ts
declare const VOICE_MESSAGE_AUDIO_EXTENSIONS: Set<string>;
/**
 * MIME types compatible with voice messages.
 */
declare const VOICE_MESSAGE_MIME_TYPES: Set<string>;
declare function isVoiceMessageCompatibleAudio(opts: {
  contentType?: string | null;
  fileName?: string | null;
}): boolean;
declare function isVoiceCompatibleAudio(opts: {
  contentType?: string | null;
  fileName?: string | null;
}): boolean;
//#endregion
export { isVoiceMessageCompatibleAudio as i, VOICE_MESSAGE_MIME_TYPES as n, isVoiceCompatibleAudio as r, VOICE_MESSAGE_AUDIO_EXTENSIONS as t };