import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";

type DiscordAudioAttachment = {
  content_type?: string;
  url?: string;
};

function collectAudioAttachments(
  attachments: DiscordAudioAttachment[] | undefined,
): DiscordAudioAttachment[] {
  if (!Array.isArray(attachments)) {
    return [];
  }
  return attachments.filter((att) => att.content_type?.startsWith("audio/"));
}

/**
 * Channel IDs for which Whisper STT transcription is always performed,
 * regardless of mention-gating configuration.  The transcript replaces
 * the (empty) message text so the agent can understand spoken content.
 *
 * These are the same two voice-channel IDs targeted by VC-02 TTS replies.
 */
export const STT_ALWAYS_TRANSCRIBE_CHANNEL_IDS = new Set([
  "1490438088080490506",
  "1490437981780312064",
]);

export async function resolveDiscordPreflightAudioMentionContext(params: {
  message: {
    attachments?: DiscordAudioAttachment[];
    content?: string;
  };
  isDirectMessage: boolean;
  shouldRequireMention: boolean;
  mentionRegexes: RegExp[];
  cfg: OpenClawConfig;
  /** Channel ID — when set and present in STT_ALWAYS_TRANSCRIBE_CHANNEL_IDS,
   *  transcription is performed unconditionally (bypasses mention gating). */
  channelId?: string;
  /** When true (from channelConfig.sttEnabled), transcription is performed
   *  unconditionally for this channel regardless of mention config. */
  sttEnabled?: boolean;
  abortSignal?: AbortSignal;
}): Promise<{
  hasAudioAttachment: boolean;
  hasTypedText: boolean;
  transcript?: string;
}> {
  const audioAttachments = collectAudioAttachments(params.message.attachments);
  const hasAudioAttachment = audioAttachments.length > 0;
  const hasTypedText = Boolean(params.message.content?.trim());

  // For designated STT channels, always transcribe audio regardless of mention config.
  // Accepts either the hardcoded channel-ID list or a config-driven sttEnabled flag.
  const isSttChannel =
    params.sttEnabled === true ||
    (Boolean(params.channelId) && STT_ALWAYS_TRANSCRIBE_CHANNEL_IDS.has(params.channelId!));

  const needsPreflightTranscription =
    !params.isDirectMessage &&
    hasAudioAttachment &&
    // `baseText` includes media placeholders; gate on typed text only.
    !hasTypedText &&
    (isSttChannel || (params.shouldRequireMention && params.mentionRegexes.length > 0));

  let transcript: string | undefined;
  if (needsPreflightTranscription) {
    if (params.abortSignal?.aborted) {
      return {
        hasAudioAttachment,
        hasTypedText,
      };
    }
    try {
      const { transcribeFirstAudio } = await import("./preflight-audio.runtime.js");
      if (params.abortSignal?.aborted) {
        return {
          hasAudioAttachment,
          hasTypedText,
        };
      }
      const audioUrls = audioAttachments
        .map((att) => att.url)
        .filter((url): url is string => typeof url === "string" && url.length > 0);
      if (audioUrls.length > 0) {
        transcript = await transcribeFirstAudio({
          ctx: {
            MediaUrls: audioUrls,
            MediaTypes: audioAttachments
              .map((att) => att.content_type)
              .filter((contentType): contentType is string => Boolean(contentType)),
          },
          cfg: params.cfg,
          agentDir: undefined,
        });
        if (params.abortSignal?.aborted) {
          transcript = undefined;
        }
      }
    } catch (err) {
      logVerbose(`discord: audio preflight transcription failed: ${String(err)}`);
    }
  }

  return {
    hasAudioAttachment,
    hasTypedText,
    transcript,
  };
}
