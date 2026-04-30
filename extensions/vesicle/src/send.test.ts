import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { describe, expect, it, vi } from "vitest";
import { sendMessageVesicle } from "./send.js";

const cfg = {
  channels: {
    vesicle: {
      serverUrl: "http://127.0.0.1:1234",
      authToken: "token",
    },
  },
} as OpenClawConfig;

describe("sendMessageVesicle", () => {
  it("sends native text to a chat GUID target", async () => {
    const client = {
      sendText: vi.fn(async () => ({
        response: new Response(JSON.stringify({ message: { messageGuid: "msg-1" } }), {
          status: 200,
        }),
        data: { message: { messageGuid: "msg-1" } },
      })),
    };

    await expect(
      sendMessageVesicle("chat_guid:iMessage;-;+15551234567", "hello", { cfg, client }),
    ).resolves.toEqual({
      to: "chat_guid:iMessage;-;+15551234567",
      messageId: "msg-1",
    });
    expect(client.sendText).toHaveBeenCalledWith({
      chatGuid: "iMessage;-;+15551234567",
      text: "hello",
      timeoutMs: 30_000,
    });
  });

  it("rejects handle targets until native chat lookup exists", async () => {
    await expect(sendMessageVesicle("+15551234567", "hello", { cfg })).rejects.toThrow(
      /chat_guid:<GUID>/,
    );
  });

  it("surfaces native error envelopes", async () => {
    const client = {
      sendText: vi.fn(async () => ({
        response: new Response(JSON.stringify({ code: "chat_not_found", message: "missing" }), {
          status: 404,
        }),
        data: { code: "chat_not_found", message: "missing" },
      })),
    };

    await expect(
      sendMessageVesicle("chat_guid:iMessage;+;chat123", "hello", { cfg, client }),
    ).rejects.toThrow("Vesicle send failed (404): chat_not_found: missing");
  });
});
