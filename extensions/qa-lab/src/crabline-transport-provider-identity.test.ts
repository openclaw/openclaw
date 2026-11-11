import { expect, it } from "vitest";
import { telegramApi, withTransport } from "./crabline-transport.test-support.js";

async function readTelegramInbound(url: string) {
  const response = await fetch(`${url}/getUpdates`);
  const updates = (await response.json()) as {
    result?: Array<{ message?: { chat?: { id?: number }; message_thread_id?: number } }>;
  };
  return updates.result?.at(-1)?.message;
}

it.each([
  ["direct", "alice/team", "alice/team", "42"],
  ["channel", "telegram-announcements", "alice", undefined],
] as const)(
  "correlates %s replies without delivery registration",
  async (kind, id, senderId, threadId) => {
    await withTransport("telegram", async (transport) => {
      const api = telegramApi(transport);
      const conversation = { kind, id };
      const target = { conversation, ...(threadId ? { threadId } : {}) };
      const inbound = await transport.sendInbound({
        ...target,
        senderId,
        text: "provider identity baseline",
      });
      if (threadId) {
        expect(inbound).toMatchObject({ conversation, threadId });
      }

      const message = await readTelegramInbound(api.url);
      expect(message).toMatchObject({
        chat: { id: expect.any(Number) },
        ...(threadId ? { message_thread_id: expect.any(Number) } : {}),
      });
      await api.post("sendMessage", {
        chat_id: message?.chat?.id,
        ...(message?.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
        text: "provider reply",
      });

      await expect(
        transport.waitForOutbound({
          ...target,
          textIncludes: "provider reply",
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({ ...target, text: "provider reply" });
    });
  },
);
