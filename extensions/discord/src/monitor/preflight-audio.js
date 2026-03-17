import { logVerbose } from "../../../../src/globals.js";
function collectAudioAttachments(attachments) {
  if (!Array.isArray(attachments)) {
    return [];
  }
  return attachments.filter((att) => att.content_type?.startsWith("audio/"));
}
async function resolveDiscordPreflightAudioMentionContext(params) {
  const audioAttachments = collectAudioAttachments(params.message.attachments);
  const hasAudioAttachment = audioAttachments.length > 0;
  const hasTypedText = Boolean(params.message.content?.trim());
  const needsPreflightTranscription = !params.isDirectMessage && params.shouldRequireMention && hasAudioAttachment && // `baseText` includes media placeholders; gate on typed text only.
  !hasTypedText && params.mentionRegexes.length > 0;
  let transcript;
  if (needsPreflightTranscription) {
    if (params.abortSignal?.aborted) {
      return {
        hasAudioAttachment,
        hasTypedText
      };
    }
    try {
      const { transcribeFirstAudio } = await import("../../../../src/media-understanding/audio-preflight.js");
      if (params.abortSignal?.aborted) {
        return {
          hasAudioAttachment,
          hasTypedText
        };
      }
      const audioUrls = audioAttachments.map((att) => att.url).filter((url) => typeof url === "string" && url.length > 0);
      if (audioUrls.length > 0) {
        transcript = await transcribeFirstAudio({
          ctx: {
            MediaUrls: audioUrls,
            MediaTypes: audioAttachments.map((att) => att.content_type).filter((contentType) => Boolean(contentType))
          },
          cfg: params.cfg,
          agentDir: void 0
        });
        if (params.abortSignal?.aborted) {
          transcript = void 0;
        }
      }
    } catch (err) {
      logVerbose(`discord: audio preflight transcription failed: ${String(err)}`);
    }
  }
  return {
    hasAudioAttachment,
    hasTypedText,
    transcript
  };
}
export {
  resolveDiscordPreflightAudioMentionContext
};
