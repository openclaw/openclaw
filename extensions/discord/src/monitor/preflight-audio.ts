import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getFileExtension } from "openclaw/plugin-sdk/media-mime";
import { createChannelPreflightAudio } from "openclaw/plugin-sdk/media-understanding-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

type DiscordAudioAttachment = {
  content_type?: string;
  duration_secs?: number;
  filename?: string;
  url?: string;
  waveform?: string;
};

const AUDIO_ATTACHMENT_MIME_BY_EXT = new Map([
  [".aac", "audio/aac"],
  [".caf", "audio/x-caf"],
  [".flac", "audio/flac"],
  [".m4a", "audio/mp4"],
  [".mp3", "audio/mpeg"],
  [".oga", "audio/ogg"],
  [".ogg", "audio/ogg"],
  [".opus", "audio/opus"],
  [".wav", "audio/wav"],
]);

function inferAudioAttachmentMime(attachment: DiscordAudioAttachment): string | undefined {
  const contentType = normalizeOptionalString(attachment.content_type);
  if (contentType?.startsWith("audio/")) {
    return contentType;
  }
  // A waveform is the definitive native Discord voice-note marker and wins even
  // against a conflicting MIME. Discord now sends duration_secs on ordinary
  // video/image attachments, so a bare duration only implies audio when the
  // declared type is not a definitive visual one.
  if (typeof normalizeOptionalString(attachment.waveform) === "string") {
    return "audio/ogg";
  }
  const definitiveVisual =
    contentType?.startsWith("video/") === true || contentType?.startsWith("image/") === true;
  if (!definitiveVisual && typeof attachment.duration_secs === "number") {
    return "audio/ogg";
  }
  const ext = getFileExtension(attachment.filename ?? attachment.url);
  return ext ? AUDIO_ATTACHMENT_MIME_BY_EXT.get(ext) : undefined;
}

const discordPreflightAudio = createChannelPreflightAudio({
  channel: "discord",
  isAudio: (attachment: DiscordAudioAttachment) =>
    Boolean(normalizeOptionalString(attachment.url) && inferAudioAttachmentMime(attachment)),
});

export const sendDiscordPreflightAudioTranscriptEcho =
  discordPreflightAudio.send.bind(discordPreflightAudio);

export async function resolveDiscordPreflightAudioMentionContext(params: {
  message: {
    attachments?: DiscordAudioAttachment[];
    content?: string;
  };
  isDirectMessage: boolean;
  shouldRequireMention: boolean;
  mentionRegexes: RegExp[];
  cfg: OpenClawConfig;
  abortSignal?: AbortSignal;
}) {
  const attachments = Array.isArray(params.message.attachments) ? params.message.attachments : [];
  const hasTypedText = Boolean(params.message.content?.trim());
  // Caption text suppresses preflight; media-only messages remain eligible.
  if (
    hasTypedText ||
    params.abortSignal?.aborted ||
    (!params.isDirectMessage && (!params.shouldRequireMention || !params.mentionRegexes.length))
  ) {
    return { hasTypedText };
  }
  const attachmentIndex = attachments.findIndex(discordPreflightAudio.isAudio);
  const attachment = attachments[attachmentIndex];
  const url = normalizeOptionalString(attachment?.url);
  if (!attachment || !url) {
    return { hasTypedText };
  }
  const transcript = await discordPreflightAudio.resolve({
    request: {
      ctx: { media: [{ url, contentType: inferAudioAttachmentMime(attachment) }] },
      cfg: params.cfg,
    },
    abortSignal: params.abortSignal,
  });
  return transcript ? { hasTypedText, transcript, attachmentIndex } : { hasTypedText };
}
