import type { Client } from "@larksuiteoapi/node-sdk";
import { describe, expect, it, vi } from "vitest";
import { sendFeishuMessage } from "./message-send.js";

function createMockClient() {
  const reply = vi.fn(async () => ({ code: 0, data: { message_id: "om_reply_ok" } }));
  const create = vi.fn(async () => ({ code: 0, data: { message_id: "om_create_ok" } }));
  return {
    client: {
      im: {
        message: {
          reply,
          create,
        },
      },
    } as unknown as Client,
    reply,
    create,
  };
}

describe("sendFeishuMessage", () => {
  it("uses im.message.reply for native om_ reply anchors", async () => {
    const { client, reply, create } = createMockClient();
    await sendFeishuMessage(
      { client, receiveId: "oc_chat", receiveIdType: "chat_id" },
      { content: '{"text":"hi"}', msgType: "text", replyToMessageId: "om_native_123" },
      "Feishu send failed",
    );
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ path: { message_id: "om_native_123" } }),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("drops internal UUID reply anchors and falls back to im.message.create", async () => {
    const { client, reply, create } = createMockClient();
    await sendFeishuMessage(
      { client, receiveId: "oc_chat", receiveIdType: "chat_id" },
      {
        content: '{"text":"hi"}',
        msgType: "text",
        replyToMessageId: "a3f4ca80-4ce8-4615-9072-9f84384120c8",
      },
      "Feishu send failed",
    );
    expect(reply).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { receive_id_type: "chat_id" },
        data: expect.objectContaining({ receive_id: "oc_chat" }),
      }),
    );
  });
});
