import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
  type ChannelMessageSendResult,
} from "openclaw/plugin-sdk/channel-outbound";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { whatsappOutboundBase } from "./outbound-base.js";
import { normalizeWhatsAppPayloadTextPreservingIndentation } from "./outbound-media-contract.js";

const loadWhatsAppApprovalReactionsModule = createLazyRuntimeModule(
  () => import("./approval-reactions.js"),
);

export const whatsappChannelOutbound = {
  ...whatsappOutboundBase,
  sendTextOnlyErrorPayloads: true,
  renderPresentation: async (
    params: Parameters<NonNullable<ChannelOutboundAdapter["renderPresentation"]>>[0],
  ) => {
    return (await loadWhatsAppApprovalReactionsModule()).prepareWhatsAppApprovalPayloadForDelivery({
      payload: params.payload,
      presentation: params.presentation,
    });
  },
  afterDeliverPayload: async (
    params: Parameters<NonNullable<ChannelOutboundAdapter["afterDeliverPayload"]>>[0],
  ): Promise<void> => {
    await (
      await loadWhatsAppApprovalReactionsModule()
    ).registerWhatsAppApprovalReactionTargetForDeliveredPayload(params);
  },
  normalizePayload: ({ payload }: { payload: { text?: string } }) => ({
    ...payload,
    text: normalizeWhatsAppPayloadTextPreservingIndentation(payload.text),
  }),
};

function toWhatsAppMessageSendResult(
  result: Awaited<ReturnType<NonNullable<typeof whatsappChannelOutbound.sendText>>>,
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
    text: async ({ onDeliveryResult, ...ctx }) => {
      const result = await whatsappChannelOutbound.sendText!({
        ...ctx,
        onDeliveryResult: onDeliveryResult
          ? async (progress) => {
              await onDeliveryResult(toWhatsAppMessageSendResult(progress, ctx.replyToId));
            }
          : undefined,
      });
      return toWhatsAppMessageSendResult(result, ctx.replyToId);
    },
  },
});
