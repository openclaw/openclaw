import type { AniInteraction, AniAttachment } from "./monitor/send.js";
import type { ChannelOutboundAdapter } from "./sdk-compat.js";
import { sendAniMessage, uploadAniFile, toggleAniReaction } from "./monitor/send.js";
import { getAniRuntime } from "./runtime.js";
import { resolveAniCredentials } from "./utils.js";

type AniSendMediaParams = Parameters<NonNullable<ChannelOutboundAdapter["sendMedia"]>>[0];
type AniChunker = NonNullable<ChannelOutboundAdapter["chunker"]>;

/** Parse conversation ID from target string like "ani:conv:123" or "123". */
export function parseConversationId(to: string): number {
  const cleaned = to
    .replace(/^ani:/i, "")
    .replace(/^conv:/i, "")
    .replace(/^channel:/i, "")
    .trim();
  if (!/^[1-9]\d*$/.test(cleaned)) {
    throw new Error(`ANI outbound: invalid conversation target "${to}"`);
  }
  return Number.parseInt(cleaned, 10);
}

/**
 * Send a text message with optional mentions and interaction card.
 * The `mentions` and `interaction` fields map directly to the ANI backend's
 * message send API (POST /api/v1/messages/send).
 */
export async function sendAniTextWithExtras(opts: {
  to: string;
  text: string;
  mentions?: number[];
  interaction?: AniInteraction;
}): Promise<{ channel: string; messageId: string; roomId: string }> {
  const { serverUrl, apiKey } = resolveAniCredentials();
  const conversationId = parseConversationId(opts.to);
  const result = await sendAniMessage({
    serverUrl,
    apiKey,
    conversationId,
    text: opts.text,
    mentions: opts.mentions,
    interaction: opts.interaction,
  });
  return {
    channel: "ani",
    messageId: String(result.messageId),
    roomId: String(conversationId),
  };
}

/**
 * Send an ack-reaction (emoji) on a specific ANI message.
 * Uses the toggle endpoint: POST /api/v1/messages/:id/reactions
 */
export async function sendAniAckReaction(messageId: number, emoji: string): Promise<void> {
  const { serverUrl, apiKey } = resolveAniCredentials();
  await toggleAniReaction({ serverUrl, apiKey, messageId, emoji });
}

export const aniOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: ((text: string, limit: number) =>
    getAniRuntime().channel.text.chunkMarkdownText(text, limit)) satisfies AniChunker,
  chunkerMode: "markdown",
  textChunkLimit: 4000,

  sendText: async ({ to, text }) => {
    const { serverUrl, apiKey } = resolveAniCredentials();
    const conversationId = parseConversationId(to);
    const result = await sendAniMessage({
      serverUrl,
      apiKey,
      conversationId,
      text,
    });
    return {
      channel: "ani",
      messageId: String(result.messageId),
      roomId: String(conversationId),
    };
  },

  sendMedia: async ({ to, text, mediaUrl }: AniSendMediaParams) => {
    const { serverUrl, apiKey } = resolveAniCredentials();
    const conversationId = parseConversationId(to);

    let attachments: AniAttachment[] | undefined;

    if (mediaUrl) {
      try {
        // Download media from the provided URL
        const mediaRes = await fetch(mediaUrl, { signal: AbortSignal.timeout(30_000) });
        if (!mediaRes.ok) {
          throw new Error(`Failed to download media (${mediaRes.status})`);
        }

        // Reject files larger than 32MB before reading the body
        const contentLength = Number(mediaRes.headers.get("content-length") || 0);
        if (contentLength > 32 * 1024 * 1024) {
          await mediaRes.body?.cancel();
          throw new Error(`Media too large: ${contentLength} bytes (max 32MB)`);
        }

        const contentType = mediaRes.headers.get("content-type") ?? "application/octet-stream";
        const buffer = new Uint8Array(await mediaRes.arrayBuffer());

        // Derive filename from URL path or use a fallback
        let filename = "file";
        try {
          const urlPath = new URL(mediaUrl).pathname;
          const lastSegment = urlPath.split("/").pop();
          if (lastSegment && lastSegment.includes(".")) {
            filename = lastSegment;
          }
        } catch {
          // URL parsing failed; keep default filename
        }

        // Upload to ANI backend
        const uploaded = await uploadAniFile({
          serverUrl,
          apiKey,
          buffer,
          filename,
        });

        // Determine attachment type from MIME
        let attachType = "file";
        if (contentType.startsWith("image/")) attachType = "image";
        else if (contentType.startsWith("audio/")) attachType = "audio";
        else if (contentType.startsWith("video/")) attachType = "video";

        attachments = [
          {
            type: attachType,
            url: uploaded.url,
            filename: uploaded.filename,
            mime_type: contentType,
            size: uploaded.size,
          },
        ];
      } catch (err) {
        // If media download/upload fails, fall back to sending text with a link
        const runtime = getAniRuntime();
        if (runtime.logging.shouldLogVerbose()) {
          runtime.logging
            .getChildLogger({ module: "ani-outbound" })
            .debug?.(`ani: sendMedia failed, falling back to text: ${String(err)}`);
        }
        const fallbackText = text
          ? `${text}\n\n[Media link: ${mediaUrl}]`
          : `[Media link: ${mediaUrl}]`;
        const result = await sendAniMessage({
          serverUrl,
          apiKey,
          conversationId,
          text: fallbackText,
        });
        return {
          channel: "ani",
          messageId: String(result.messageId),
          roomId: String(conversationId),
        };
      }
    }

    // Determine content type from first attachment
    const contentType = attachments?.[0]?.type;

    const result = await sendAniMessage({
      serverUrl,
      apiKey,
      conversationId,
      text: text ?? "",
      attachments,
      contentType,
    });
    return {
      channel: "ani",
      messageId: String(result.messageId),
      roomId: String(conversationId),
    };
  },
};
