import { describe, expect, it } from "vitest";
import { telegramApi, withTransport } from "./crabline-transport.test-support.js";

async function readTelegramInbound(url: string) {
  const response = await fetch(`${url}/getUpdates`);
  const updates = (await response.json()) as {
    result?: Array<{ message?: { chat?: { id?: number }; message_thread_id?: number } }>;
  };
  return updates.result?.at(-1)?.message;
}

describe("Crabline Telegram provider identity", () => {
  it.each([
    {
      conversation: { id: "alice/team", kind: "direct" },
      senderId: "alice/team",
      threadId: "42",
    },
    {
      conversation: { id: "telegram-announcements", kind: "channel" },
      senderId: "alice",
      threadId: undefined,
    },
  ] as const)(
    "correlates $conversation.kind replies without delivery registration",
    async ({ conversation, senderId, threadId }) => {
      await withTransport("telegram", async (transport) => {
        const api = telegramApi(transport);
        const inbound = await transport.sendInbound({
          conversation,
          senderId,
          text: "provider identity baseline",
          ...(threadId ? { threadId } : {}),
        });
        if (threadId) {
          expect(inbound).toMatchObject({ conversation, threadId });
        }

        const message = await readTelegramInbound(api.url);
        expect(message?.chat?.id).toEqual(expect.any(Number));
        if (threadId) {
          expect(message?.message_thread_id).toEqual(expect.any(Number));
        }
        await api.post("sendMessage", {
          chat_id: message?.chat?.id,
          ...(message?.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
          text: "provider reply",
        });

        await expect(
          transport.waitForOutbound({
            conversation,
            textIncludes: "provider reply",
            ...(threadId ? { threadId } : {}),
            timeoutMs: 1_000,
          }),
        ).resolves.toMatchObject({
          conversation,
          text: "provider reply",
          ...(threadId ? { threadId } : {}),
        });
      });
    },
  );
});
