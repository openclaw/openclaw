import type { WAMessage } from "baileys";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { describe, expect, it } from "vitest";
import {
  combineWhatsAppSendResults,
  mergeWhatsAppAcceptedSendError,
  normalizeWhatsAppSendResult,
  requireWhatsAppAcceptedSendResult,
} from "./send-result.js";

describe("WhatsApp send receipts", () => {
  it("rejects listener results that claim an unauthenticated provider receipt", () => {
    expect(() =>
      requireWhatsAppAcceptedSendResult({
        kind: "text",
        messageId: "unknown",
        keys: [],
        providerAccepted: false,
      }),
    ).toThrow(PlatformMessageNotDispatchedError);
  });

  it("rejects empty send batches instead of fabricating an unknown receipt", () => {
    expect(() => combineWhatsAppSendResults("text", [])).toThrow(PlatformMessageNotDispatchedError);
  });

  it("rebuilds matching nested receipts whose existing raw provider metadata is incomplete", () => {
    const key = {
      id: "receipt-raw-enrichment",
      remoteJid: "123@s.whatsapp.net",
      fromMe: true,
      participant: "456@s.whatsapp.net",
    };
    const accepted = normalizeWhatsAppSendResult({ key } as WAMessage, "text");
    const providerReceipt = accepted.receipt;
    if (!providerReceipt) {
      throw new Error("accepted WhatsApp send did not expose its provider receipt");
    }
    const context = { threadId: "provider-thread", replyToId: "provider-reply" };
    const tokens = { editToken: "provider-edit-token", deleteToken: "provider-delete-token" };
    accepted.receipt = {
      ...providerReceipt,
      ...context,
      ...tokens,
      parts: providerReceipt.parts.map((part) => Object.assign({}, part, { index: 7, ...context })),
    };
    const incompleteReceipt = {
      ...accepted.receipt,
      raw: [{ channel: "whatsapp", messageId: accepted.messageId }],
      parts: accepted.receipt.parts.map((part) => ({
        ...part,
        raw: { channel: "whatsapp", messageId: part.platformMessageId },
      })),
    };
    const originalCause = new Error("provider bookkeeping failed after accepted delivery");
    const delivery = {
      messageIds: [accepted.messageId],
      receipt: incompleteReceipt,
      visibleReplySent: true as const,
    };
    const partial = createChannelPartialDeliveryError(originalCause, delivery);
    const wrapped = createChannelPartialDeliveryError(partial, delivery);

    const enriched = mergeWhatsAppAcceptedSendError({
      error: wrapped,
      kind: "text",
      results: [accepted],
    });

    if (!isChannelPartialDeliveryError(enriched)) {
      throw new Error("existing incomplete nested raw suppressed canonical receipt reconstruction");
    }
    expect(enriched).not.toBe(wrapped);
    expect(enriched).toHaveProperty("cause", originalCause);
    const expectedRaw = {
      channel: "whatsapp",
      messageId: "receipt-raw-enrichment",
      toJid: "123@s.whatsapp.net",
      meta: { fromMe: true, participant: "456@s.whatsapp.net" },
    };
    const expectedPart = {
      platformMessageId: "receipt-raw-enrichment",
      kind: "text",
      index: 7,
      ...context,
      raw: expectedRaw,
    };
    expect(enriched.deliveryResult.receipt).toMatchObject({
      primaryPlatformMessageId: "receipt-raw-enrichment",
      platformMessageIds: ["receipt-raw-enrichment"],
      ...context,
      ...tokens,
      raw: [expectedRaw],
      parts: [expectedPart],
    });
    expect(enriched).toMatchObject({ sentBeforeError: true, visibleReplySent: true });
  });
});
