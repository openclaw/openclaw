import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import type { ChannelMessageSendResult } from "openclaw/plugin-sdk/channel-outbound";
import { expect, vi, type Mock } from "vitest";
import type { sendSmsViaTwilio } from "./twilio.js";

export function createPartialSmsSend(
  send: Mock<typeof sendSmsViaTwilio>,
  messageId: string,
  kind: "text" | "media",
) {
  const events: string[] = [];
  send
    .mockImplementationOnce(async ({ to, onPlatformSendDispatch }) => {
      await onPlatformSendDispatch?.();
      events.push("send:first");
      return { sid: messageId, to };
    })
    .mockImplementationOnce(async ({ onPlatformSendDispatch }) => {
      await onPlatformSendDispatch?.();
      events.push("send:second");
      throw new Error("second chunk failed");
    });
  const onDeliveryResult = vi.fn(async (result: ChannelMessageSendResult) => {
    events.push(`delivery:${result.messageId}`);
  });
  const onPlatformSendDispatch = vi.fn(async () => {
    events.push("dispatch");
  });
  return {
    onDeliveryResult,
    onPlatformSendDispatch,
    expectPartial(error: unknown) {
      expect(isChannelPartialDeliveryError(error)).toBe(true);
      if (!isChannelPartialDeliveryError(error)) {
        throw error;
      }
      const part = { platformMessageId: messageId, kind };
      expect(error.deliveryResult).toMatchObject({
        messageIds: [messageId],
        visibleReplySent: true,
        receipt: { parts: [part] },
      });
      expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith({
        channel: "sms",
        messageId,
        chatId: "+15551234567",
        receipt: expect.objectContaining({
          platformMessageIds: [messageId],
          parts: [expect.objectContaining(part)],
        }),
      });
      expect(send).toHaveBeenCalledTimes(2);
      expect(onPlatformSendDispatch).toHaveBeenCalledTimes(2);
      expect(events).toEqual([
        "dispatch",
        "send:first",
        `delivery:${messageId}`,
        "dispatch",
        "send:second",
      ]);
    },
  };
}
