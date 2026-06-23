import {
  buildChannelInboundMediaPayload,
  toInboundMediaFacts,
} from "openclaw/plugin-sdk/channel-inbound";
import { attachment, voice, type Message } from "spectrum-ts";

export type SpectrumInboundMedia = {
  kind: "image" | "video" | "audio";
  url: string;
  contentType?: string;
  messageId?: string;
};

function inferSpectrumMediaMime(params: {
  kind: SpectrumInboundMedia["kind"];
  contentType?: string;
  url: string;
}): string {
  if (params.contentType?.trim()) {
    return params.contentType.trim();
  }
  const lower = params.url.toLowerCase();
  if (params.kind === "image") {
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".gif")) return "image/gif";
    if (lower.endsWith(".webp")) return "image/webp";
    return "image/jpeg";
  }
  if (params.kind === "video") {
    if (lower.endsWith(".mov")) return "video/quicktime";
    if (lower.endsWith(".webm")) return "video/webm";
    return "video/mp4";
  }
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  return "audio/mpeg";
}

export function buildSpectrumInboundMediaPayload(
  media: readonly SpectrumInboundMedia[],
): ReturnType<typeof buildChannelInboundMediaPayload> {
  return buildChannelInboundMediaPayload(
    toInboundMediaFacts(
      media.map((entry) => ({
        kind: entry.kind,
        url: entry.url,
        contentType: inferSpectrumMediaMime(entry),
        messageId: entry.messageId,
      })),
    ),
  );
}

export function extractSpectrumInboundMedia(message: Message): SpectrumInboundMedia[] {
  const content = message.content as {
    type?: string;
    image?: { url?: string; mimeType?: string };
    video?: { url?: string; mimeType?: string };
    audio?: { url?: string; mimeType?: string };
  };
  if (content.type === "image" && content.image?.url) {
    return [
      {
        kind: "image",
        url: content.image.url,
        contentType: content.image.mimeType,
        messageId: message.id,
      },
    ];
  }
  if (content.type === "video" && content.video?.url) {
    return [
      {
        kind: "video",
        url: content.video.url,
        contentType: content.video.mimeType,
        messageId: message.id,
      },
    ];
  }
  if (content.type === "audio" && content.audio?.url) {
    return [
      {
        kind: "audio",
        url: content.audio.url,
        contentType: content.audio.mimeType,
        messageId: message.id,
      },
    ];
  }
  return [];
}

export function buildSpectrumOutboundMediaContent(params: {
  mediaUrl: string;
  audioAsVoice?: boolean;
}) {
  if (params.audioAsVoice) {
    return voice(new URL(params.mediaUrl));
  }
  return attachment(new URL(params.mediaUrl));
}
