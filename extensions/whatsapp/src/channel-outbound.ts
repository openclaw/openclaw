import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
  type ChannelMessageSendResult,
} from "openclaw/plugin-sdk/channel-message";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { createRuntimeOutboundDelegates } from "openclaw/plugin-sdk/outbound-runtime";
import { chunkText } from "openclaw/plugin-sdk/reply-chunking";
import { normalizeWhatsAppPayloadTextPreservingIndentation } from "./outbound-text.js";
import { resolveWhatsAppOutboundTarget } from "./resolve-outbound-target.js";

const loadWhatsAppChannelOutboundRuntime = createLazyRuntimeModule(
  () => import("./channel-outbound.runtime.js"),
);

export function normalizeWhatsAppChannelPayloadText(text: string | undefined): string {
  return normalizeWhatsAppPayloadTextPreservingIndentation(text);
}

function normalizeWhatsAppChannelSendText(text: string | undefined): string {
  const normalized = normalizeWhatsAppChannelPayloadText(text);
  return normalized.trim() ? normalized : "";
}

export const whatsappChannelOutbound: ChannelOutboundAdapter = {
  deliveryMode: "gateway",
  chunker: chunkText,
  chunkerMode: "text",
  textChunkLimit: 4000,
  sanitizeText: ({ text }) => normalizeWhatsAppChannelSendText(text),
  deliveryCapabilities: {
    durableFinal: {
      text: true,
      replyTo: true,
      messageSendingHooks: true,
    },
  },
  pollMaxOptions: 12,
  resolveTarget: ({ to, allowFrom, mode }) =>
    resolveWhatsAppOutboundTarget({ to, allowFrom, mode }),
  ...createRuntimeOutboundDelegates({
    getRuntime: loadWhatsAppChannelOutboundRuntime,
    sendPayload: {
      resolve: (runtime) => runtime.whatsappChannelRuntimeOutbound.sendPayload,
      unavailableMessage: "WhatsApp outbound payload delivery is unavailable",
    },
    sendText: {
      resolve: (runtime) => runtime.whatsappChannelRuntimeOutbound.sendText,
      unavailableMessage: "WhatsApp outbound text delivery is unavailable",
    },
    sendMedia: {
      resolve: (runtime) => runtime.whatsappChannelRuntimeOutbound.sendMedia,
      unavailableMessage: "WhatsApp outbound media delivery is unavailable",
    },
    sendPoll: {
      resolve: (runtime) => runtime.whatsappChannelRuntimeOutbound.sendPoll,
      unavailableMessage: "WhatsApp outbound poll delivery is unavailable",
    },
  }),
  sendTextOnlyErrorPayloads: true,
  normalizePayload: ({ payload }: { payload: { text?: string } }) => ({
    ...payload,
    text: normalizeWhatsAppChannelPayloadText(payload.text),
  }),
};

function toWhatsAppMessageSendResult(
  result: Awaited<ReturnType<NonNullable<ChannelOutboundAdapter["sendText"]>>>,
  replyToId?: string | null,
): ChannelMessageSendResult {
  const source = result as typeof result & { toJid?: string };
  const receipt =
    result.receipt ??
    createMessageReceiptFromOutboundResults({
      results: result.messageId
        ? [
            {
              channel: "whatsapp",
              messageId: result.messageId,
              toJid: source.toJid,
            },
          ]
        : [],
      kind: "text",
      ...(replyToId ? { replyToId } : {}),
    });
  return {
    messageId: result.messageId || receipt.primaryPlatformMessageId,
    receipt,
  };
}

export const whatsappMessageAdapter = defineChannelMessageAdapter({
  id: "whatsapp",
  durableFinal: {
    capabilities: {
      text: true,
      replyTo: true,
      messageSendingHooks: true,
    },
  },
  send: {
    text: async (ctx) =>
      toWhatsAppMessageSendResult(
        await whatsappChannelOutbound.sendText!({
          ...ctx,
        }),
        ctx.replyToId,
      ),
  },
});
