import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatAudioTranscriptForAgent } from "openclaw/plugin-sdk/media-understanding-runtime";
import type { AdmittedWebInboundMessage, WhatsAppInboundMedia } from "../../inbound/types.js";

function isWhatsAppAudioMedia(media: WhatsAppInboundMedia | undefined): boolean {
  return media?.kind === "audio" || media?.type?.startsWith("audio/") === true;
}

export function hasWhatsAppAudioBody(msg: AdmittedWebInboundMessage): boolean {
  return isWhatsAppAudioMedia(msg.payload.media) && !msg.payload.body.trim();
}

export async function transcribeWhatsAppAudioMessage(
  cfg: OpenClawConfig,
  msg: AdmittedWebInboundMessage,
  accountId: string | undefined,
): Promise<string | undefined> {
  const { transcribeFirstAudio } = await import("./audio-preflight.runtime.js");
  return await transcribeFirstAudio(
    buildAudioPreflightParams(cfg, msg, msg.payload.media, accountId),
  );
}

function buildAudioPreflightParams(
  cfg: OpenClawConfig,
  msg: AdmittedWebInboundMessage,
  media: WhatsAppInboundMedia | undefined,
  accountId: string | undefined,
) {
  const conversationId = msg.admission.conversation.id;
  return {
    ctx: {
      media: [{ path: media?.path, contentType: media?.type, kind: media?.kind ?? undefined }],
      From: conversationId,
      To: msg.platform.recipientJid,
      Provider: "whatsapp",
      Surface: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: conversationId,
      AccountId: accountId,
    },
    cfg,
  };
}

/** Lists turn attachments in arrival order; batched turns carry them in their parts. */
export function listWhatsAppInboundMedia(msg: AdmittedWebInboundMessage): WhatsAppInboundMedia[] {
  const parts = msg.payload.batchedParts;
  if (parts) {
    return parts.flatMap((part) => (part.media ? [part.media] : []));
  }
  return msg.payload.media ? [msg.payload.media] : [];
}

/**
 * Transcribes each uncaptioned voice note in a debounced batch and rebuilds the agent body in
 * arrival order. Indexes refer to {@link listWhatsAppInboundMedia} so core STT skips them.
 */
export async function transcribeWhatsAppBatchedAudio(
  cfg: OpenClawConfig,
  msg: AdmittedWebInboundMessage,
  accountId: string | undefined,
): Promise<{ body: string; transcript: string; transcribedIndexes: number[] } | undefined> {
  const parts = msg.payload.batchedParts;
  if (!parts) {
    return undefined;
  }
  const hasVoiceNote = parts.some(
    (part) => part.media?.path && !part.body.trim() && isWhatsAppAudioMedia(part.media),
  );
  if (!hasVoiceNote) {
    return undefined;
  }
  // Load the STT runtime once; the voice notes then transcribe concurrently.
  const { transcribeFirstAudio } = await import("./audio-preflight.runtime.js");
  let mediaCount = 0;
  const resolved = await Promise.all(
    parts.map(async (part) => {
      // Count every attachment, including unreadable ones, so indexes match the media list.
      const mediaIndex = part.media ? mediaCount++ : -1;
      if (!part.media?.path || part.body.trim() || !isWhatsAppAudioMedia(part.media)) {
        return { body: part.body };
      }
      // Failures keep the structured audio fact, matching single-message preflight.
      const transcript = await transcribeFirstAudio(
        buildAudioPreflightParams(cfg, msg, part.media, accountId),
      ).catch(() => undefined);
      return transcript === undefined
        ? { body: part.body }
        : {
            body: formatAudioTranscriptForAgent(transcript),
            transcribed: { transcript, mediaIndex },
          };
    }),
  );
  const transcribed = resolved.flatMap((entry) => (entry.transcribed ? [entry.transcribed] : []));
  if (transcribed.length === 0) {
    return undefined;
  }
  return {
    body: resolved
      .map((entry) => entry.body)
      .filter(Boolean)
      .join("\n"),
    transcript: transcribed.map((entry) => entry.transcript).join("\n"),
    transcribedIndexes: transcribed.map((entry) => entry.mediaIndex),
  };
}
