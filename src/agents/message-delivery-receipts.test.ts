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
