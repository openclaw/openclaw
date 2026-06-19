import { describe, expect, it } from "vitest";
import { normalizeMessageToolDeliveryEvidence } from "./message-delivery-receipts.js";

describe("message delivery receipts", () => {
  it("normalizes built-in message tool SMS receipts into evidence", () => {
    expect(
      normalizeMessageToolDeliveryEvidence({
        toolName: "message",
        result: {
          channel: "sms",
          messageId: "SM-default",
          chatId: "+15551234567",
          receipt: {
            raw: [
              {
                channel: "sms",
                messageId: "SM-default",
                chatId: "+15551234567",
                toJid: "+15551234567",
                meta: {
                  from: "+15557654321",
                  status: "queued",
                },
              },
            ],
          },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        channel: "sms",
        toolName: "message",
        providerId: "SM-default",
        status: "queued",
        sender: "+15557654321",
        recipient: "+15551234567",
      }),
    ]);
  });

  it("normalizes built-in message tool SMS receipts from AgentToolResult details", () => {
    expect(
      normalizeMessageToolDeliveryEvidence({
        toolName: "message",
        result: {
          content: [
            {
              type: "text",
              text: "{}",
            },
          ],
          details: {
            channel: "sms",
            messageId: "SM-details",
            chatId: "+15551234567",
            receipt: {
              raw: [
                {
                  channel: "sms",
                  messageId: "SM-details",
                  chatId: "+15551234567",
                  toJid: "+15551234567",
                  meta: {
                    from: "+15557654321",
                    status: "queued",
                  },
                },
              ],
            },
          },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        channel: "sms",
        toolName: "message",
        providerId: "SM-details",
        status: "queued",
        sender: "+15557654321",
        recipient: "+15551234567",
      }),
    ]);
  });

  it("normalizes built-in message tool core send result receipts from AgentToolResult details", () => {
    expect(
      normalizeMessageToolDeliveryEvidence({
        toolName: "message",
        result: {
          content: [
            {
              type: "text",
              text: "{}",
            },
          ],
          details: {
            action: "send",
            channel: "sms",
            to: "+15551234567",
            result: {
              channel: "sms",
              messageId: "SM-core-result",
              toJid: "+15551234567",
              status: "sent",
            },
          },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        channel: "sms",
        toolName: "message",
        providerId: "SM-core-result",
        status: "sent",
        recipient: "+15551234567",
      }),
    ]);
  });

  it("normalizes built-in message tool sendResult receipts from AgentToolResult details", () => {
    expect(
      normalizeMessageToolDeliveryEvidence({
        toolName: "message",
        result: {
          content: [
            {
              type: "text",
              text: "{}",
            },
          ],
          details: {
            action: "send",
            channel: "sms",
            to: "+15551234567",
            sendResult: {
              channel: "sms",
              messageId: "SM-send-result",
              toJid: "+15551234567",
              status: "queued",
            },
          },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        channel: "sms",
        toolName: "message",
        providerId: "SM-send-result",
        status: "queued",
        recipient: "+15551234567",
      }),
    ]);
  });

  it("normalizes existing deliveryStatus success envelopes from AgentToolResult details", () => {
    expect(
      normalizeMessageToolDeliveryEvidence({
        toolName: "message",
        result: {
          details: {
            channel: "sms",
            messageId: "SM-delivery-status",
            chatId: "+15551234567",
            deliveryStatus: "sent",
          },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        channel: "sms",
        toolName: "message",
        providerId: "SM-delivery-status",
        status: "sent",
        recipient: "+15551234567",
      }),
    ]);
  });

  it("normalizes existing bare ok message-id envelopes as sent evidence", () => {
    expect(
      normalizeMessageToolDeliveryEvidence({
        toolName: "message",
        result: {
          details: {
            channel: "sms",
            messageId: "SM-ok-status",
            chatId: "+15551234567",
            status: "ok",
          },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        channel: "sms",
        toolName: "message",
        providerId: "SM-ok-status",
        status: "sent",
        recipient: "+15551234567",
      }),
    ]);
  });

  it("normalizes existing ok true message-id envelopes as sent evidence", () => {
    expect(
      normalizeMessageToolDeliveryEvidence({
        toolName: "message",
        result: {
          details: {
            channel: "sms",
            messageId: "SM-ok-true",
            chatId: "+15551234567",
            ok: true,
          },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        channel: "sms",
        toolName: "message",
        providerId: "SM-ok-true",
        status: "sent",
        recipient: "+15551234567",
      }),
    ]);
  });

  it("normalizes SMS broadcast target results into delivery evidence", () => {
    expect(
      normalizeMessageToolDeliveryEvidence({
        toolName: "message",
        result: {
          details: {
            action: "broadcast",
            channel: "sms",
            payload: {
              results: [
                {
                  channel: "sms",
                  to: "+15551234567",
                  ok: true,
                  result: {
                    channel: "sms",
                    messageId: "SM-broadcast",
                    toJid: "+15551234567",
                    status: "sent",
                  },
                },
              ],
            },
          },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        channel: "sms",
        toolName: "message",
        providerId: "SM-broadcast",
        status: "sent",
        recipient: "+15551234567",
      }),
    ]);
  });

  it("rejects failed and non-SMS message receipts", () => {
    expect(
      normalizeMessageToolDeliveryEvidence({
        toolName: "message",
        result: {
          channel: "sms",
          messageId: "SM-failed",
          chatId: "+15551234567",
          status: "failed",
        },
      }),
    ).toEqual([]);
    expect(
      normalizeMessageToolDeliveryEvidence({
        toolName: "message",
        result: {
          channel: "telegram",
          messageId: "TG-sent",
          chatId: "123",
          status: "sent",
        },
      }),
    ).toEqual([]);
  });
});
