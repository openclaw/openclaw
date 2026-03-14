import { chunkText } from "../../../src/auto-reply/chunk.js";
import { sendTextMediaPayload } from "../../../src/channels/plugins/outbound/direct-text-media.js";
import type { ChannelOutboundAdapter } from "../../../src/channels/plugins/types.js";
import { shouldLogVerbose } from "../../../src/globals.js";
import { resolveWhatsAppOutboundTarget } from "../../../src/whatsapp/resolve-outbound-target.js";
import { sendPollWhatsApp } from "./send.js";

function trimLeadingWhitespace(text: string | undefined): string {
  return text?.trimStart() ?? "";
}

export const whatsappOutbound: ChannelOutboundAdapter = {
  deliveryMode: "gateway",
  chunker: chunkText,
  chunkerMode: "text",
  textChunkLimit: 4000,
  pollMaxOptions: 12,
  resolveTarget: ({ to, allowFrom, mode }) =>
    resolveWhatsAppOutboundTarget({ to, allowFrom, mode }),
  sendPayload: async (ctx) => {
    const text = trimLeadingWhitespace(ctx.payload.text);
    const hasMedia = Boolean(ctx.payload.mediaUrl) || (ctx.payload.mediaUrls?.length ?? 0) > 0;
    if (!text && !hasMedia) {
      return { channel: "whatsapp", messageId: "" };
    }
    return await sendTextMediaPayload({
      channel: "whatsapp",
      ctx: {
        ...ctx,
        payload: {
          ...ctx.payload,
          text,
        },
      },
      adapter: whatsappOutbound,
    });
  },
  sendText: async ({ cfg, to, text, accountId, deps, gifPlayback }) => {
    const normalizedText = trimLeadingWhitespace(text);
    if (!normalizedText) {
      return { channel: "whatsapp", messageId: "" };
    }
    const send = deps?.sendWhatsApp ?? (await import("./send.js")).sendMessageWhatsApp;
    const result = await send(to, normalizedText, {
      verbose: false,
      cfg,
      accountId: accountId ?? undefined,
      gifPlayback,
    });
    return { channel: "whatsapp", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, accountId, deps, gifPlayback }) => {
    const normalizedText = trimLeadingWhitespace(text);
    const send = deps?.sendWhatsApp ?? (await import("./send.js")).sendMessageWhatsApp;
    const result = await send(to, normalizedText, {
      verbose: false,
      cfg,
      mediaUrl,
      mediaLocalRoots,
      accountId: accountId ?? undefined,
      gifPlayback,
    });
    return { channel: "whatsapp", ...result };
  },
  sendPoll: async ({ cfg, to, poll, accountId }) =>
    await sendPollWhatsApp(to, poll, {
      verbose: shouldLogVerbose(),
      accountId: accountId ?? undefined,
      cfg,
    }),
};
