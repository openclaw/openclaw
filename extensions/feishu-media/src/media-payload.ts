/**
 * Custom media payload builder with transcript support.
 *
 * Extracted from extensions/feishu/src/bot.ts on the dev branch.
 * Replaces the generic buildAgentMediaPayload() to include the Transcript
 * field when audio STT produced a result.
 */

export type FeishuMediaInfoExt = {
  path: string;
  contentType?: string;
  placeholder: string;
  /** Optional transcript for audio (e.g. Feishu native STT or Whisper result) */
  transcript?: string;
};

export type FeishuMediaPayload = {
  MediaPath?: string;
  MediaType?: string;
  MediaUrl?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
  Transcript?: string;
};

/**
 * Build a media payload for inbound context, similar to Discord's
 * buildDiscordMediaPayload() but including the Transcript field from STT.
 */
export function buildFeishuMediaPayload(mediaList: FeishuMediaInfoExt[]): FeishuMediaPayload {
  const first = mediaList[0];
  const mediaPaths = mediaList.map((media) => media.path);
  const mediaTypes = mediaList.map((media) => media.contentType).filter(Boolean) as string[];
  const transcript = mediaList.find((m) => m.transcript)?.transcript;

  return {
    MediaPath: first?.path,
    MediaType: first?.contentType,
    MediaUrl: first?.path,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
    Transcript: transcript || undefined,
  };
}
