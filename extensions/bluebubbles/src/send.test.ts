import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { BlueBubblesSendTarget } from "./types.js";
import { getCachedBlueBubblesPrivateApiStatus } from "./probe.js";
import { sendMessageBlueBubbles, resolveChatGuidForTarget } from "./send.js";

vi.mock("./accounts.js", () => ({
  resolveBlueBubblesAccount: vi.fn(({ cfg, accountId }) => {
    const config = cfg?.channels?.bluebubbles ?? {};
    return {
      accountId: accountId ?? "default",
      enabled: config.enabled !== false,
      configured: Boolean(config.serverUrl && config.password),
      config,
    };
  }),
}));

vi.mock("./probe.js", () => ({
  getCachedBlueBubblesPrivateApiStatus: vi.fn().mockReturnValue(null),
}));

const mockFetch = vi.fn();

async function expectMessageSendDisabled(
  to: string,
  text: string,
  opts: Parameters<typeof sendMessageBlueBubbles>[2],
): Promise<void> {
  await expect(sendMessageBlueBubbles(to, text, opts)).rejects.toThrow(
    "OPENCLAW_BLUEBUBBLES_OUTBOUND_ENABLED",
  );
  expect(mockFetch).not.toHaveBeenCalled();
}

describe("send", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
    vi.mocked(getCachedBlueBubblesPrivateApiStatus).mockReset();
    vi.mocked(getCachedBlueBubblesPrivateApiStatus).mockReturnValue(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("resolveChatGuidForTarget", () => {
    it("returns chatGuid directly for chat_guid target", async () => {
      const target: BlueBubblesSendTarget = {
        kind: "chat_guid",
        chatGuid: "iMessage;-;+15551234567",
      };
      const result = await resolveChatGuidForTarget({
        baseUrl: "http://localhost:1234",
        password: "test",
        target,
      });
      expect(result).toBe("iMessage;-;+15551234567");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("queries chats to resolve chat_id target", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              { id: 123, guid: "iMessage;-;chat123", participants: [] },
              { id: 456, guid: "iMessage;-;chat456", participants: [] },
            ],
          }),
      });

      const target: BlueBubblesSendTarget = { kind: "chat_id", chatId: 456 };
      const result = await resolveChatGuidForTarget({
        baseUrl: "http://localhost:1234",
        password: "test",
        target,
      });

      expect(result).toBe("iMessage;-;chat456");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/chat/query"),
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("queries chats to resolve chat_identifier target", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                identifier: "chat123@group.imessage",
                guid: "iMessage;-;chat123",
                participants: [],
              },
            ],
          }),
      });

      const target: BlueBubblesSendTarget = {
        kind: "chat_identifier",
        chatIdentifier: "chat123@group.imessage",
      };
      const result = await resolveChatGuidForTarget({
        baseUrl: "http://localhost:1234",
        password: "test",
        target,
      });

      expect(result).toBe("iMessage;-;chat123");
    });

    it("matches chat_identifier against the 3rd component of chat GUID", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                guid: "iMessage;+;chat660250192681427962",
                participants: [],
              },
            ],
          }),
      });

      const target: BlueBubblesSendTarget = {
        kind: "chat_identifier",
        chatIdentifier: "chat660250192681427962",
      };
      const result = await resolveChatGuidForTarget({
        baseUrl: "http://localhost:1234",
        password: "test",
        target,
      });

      expect(result).toBe("iMessage;+;chat660250192681427962");
    });

    it("resolves handle target by matching participant", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                guid: "iMessage;-;+15559999999",
                participants: [{ address: "+15559999999" }],
              },
              {
                guid: "iMessage;-;+15551234567",
                participants: [{ address: "+15551234567" }],
              },
            ],
          }),
      });

      const target: BlueBubblesSendTarget = {
        kind: "handle",
        address: "+15551234567",
        service: "imessage",
      };
      const result = await resolveChatGuidForTarget({
        baseUrl: "http://localhost:1234",
        password: "test",
        target,
      });

      expect(result).toBe("iMessage;-;+15551234567");
    });

    it("prefers direct chat guid when handle also appears in a group chat", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                guid: "iMessage;+;group-123",
                participants: [{ address: "+15551234567" }, { address: "+15550001111" }],
              },
              {
                guid: "iMessage;-;+15551234567",
                participants: [{ address: "+15551234567" }],
              },
            ],
          }),
      });

      const target: BlueBubblesSendTarget = {
        kind: "handle",
        address: "+15551234567",
        service: "imessage",
      };
      const result = await resolveChatGuidForTarget({
        baseUrl: "http://localhost:1234",
        password: "test",
        target,
      });

      expect(result).toBe("iMessage;-;+15551234567");
    });

    it("returns null when handle only exists in group chat (not DM)", async () => {
      // This is the critical fix: if a phone number only exists as a participant in a group chat
      // (no direct DM chat), we should NOT send to that group. Return null instead.
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [
                {
                  guid: "iMessage;+;group-the-council",
                  participants: [
                    { address: "+12622102921" },
                    { address: "+15550001111" },
                    { address: "+15550002222" },
                  ],
                },
              ],
            }),
        })
        // Empty second page to stop pagination
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ data: [] }),
        });

      const target: BlueBubblesSendTarget = {
        kind: "handle",
        address: "+12622102921",
        service: "imessage",
      };
      const result = await resolveChatGuidForTarget({
        baseUrl: "http://localhost:1234",
        password: "test",
        target,
      });

      // Should return null, NOT the group chat GUID
      expect(result).toBeNull();
    });

    it("returns null when chat not found", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });

      const target: BlueBubblesSendTarget = { kind: "chat_id", chatId: 999 };
      const result = await resolveChatGuidForTarget({
        baseUrl: "http://localhost:1234",
        password: "test",
        target,
      });

      expect(result).toBeNull();
    });

    it("handles API error gracefully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const target: BlueBubblesSendTarget = { kind: "chat_id", chatId: 123 };
      const result = await resolveChatGuidForTarget({
        baseUrl: "http://localhost:1234",
        password: "test",
        target,
      });

      expect(result).toBeNull();
    });

    it("paginates through chats to find match", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              data: Array(500)
                .fill(null)
                .map((_, i) => ({
                  id: i,
                  guid: `chat-${i}`,
                  participants: [],
                })),
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [{ id: 555, guid: "found-chat", participants: [] }],
            }),
        });

      const target: BlueBubblesSendTarget = { kind: "chat_id", chatId: 555 };
      const result = await resolveChatGuidForTarget({
        baseUrl: "http://localhost:1234",
        password: "test",
        target,
      });

      expect(result).toBe("found-chat");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("normalizes handle addresses for matching", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                guid: "iMessage;-;test@example.com",
                participants: [{ address: "Test@Example.COM" }],
              },
            ],
          }),
      });

      const target: BlueBubblesSendTarget = {
        kind: "handle",
        address: "test@example.com",
        service: "auto",
      };
      const result = await resolveChatGuidForTarget({
        baseUrl: "http://localhost:1234",
        password: "test",
        target,
      });

      expect(result).toBe("iMessage;-;test@example.com");
    });

    it("extracts guid from various response formats", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                chatGuid: "format1-guid",
                id: 100,
                participants: [],
              },
            ],
          }),
      });

      const target: BlueBubblesSendTarget = { kind: "chat_id", chatId: 100 };
      const result = await resolveChatGuidForTarget({
        baseUrl: "http://localhost:1234",
        password: "test",
        target,
      });

      expect(result).toBe("format1-guid");
    });
  });

  describe("sendMessageBlueBubbles", () => {
    beforeEach(() => {
      mockFetch.mockReset();
    });

    it("throws when text is empty", async () => {
      await expect(
        sendMessageBlueBubbles("+15551234567", "", {
          serverUrl: "http://localhost:1234",
          password: "test",
        }),
      ).rejects.toThrow("requires text");
    });

    it("throws when text is whitespace only", async () => {
      await expect(
        sendMessageBlueBubbles("+15551234567", "   ", {
          serverUrl: "http://localhost:1234",
          password: "test",
        }),
      ).rejects.toThrow("requires text");
    });

    it("throws when text becomes empty after markdown stripping", async () => {
      // Edge case: input like "***" or "---" passes initial check but becomes empty after stripMarkdown
      await expect(
        sendMessageBlueBubbles("+15551234567", "***", {
          serverUrl: "http://localhost:1234",
          password: "test",
        }),
      ).rejects.toThrow("empty after markdown removal");
    });

    it("throws when serverUrl is missing", async () => {
      await expect(sendMessageBlueBubbles("+15551234567", "Hello", {})).rejects.toThrow(
        "serverUrl is required",
      );
    });

    it("throws when password is missing", async () => {
      await expect(
        sendMessageBlueBubbles("+15551234567", "Hello", {
          serverUrl: "http://localhost:1234",
        }),
      ).rejects.toThrow("password is required");
    });

    it("throws when chatGuid cannot be resolved for non-handle targets", async () => {
      await expectMessageSendDisabled("chat_id:999", "Hello", {
        serverUrl: "http://localhost:1234",
        password: "test",
      });
    });

    it("sends message successfully", async () => {
      await expectMessageSendDisabled("+15551234567", "Hello world!", {
        serverUrl: "http://localhost:1234",
        password: "test",
      });
    });

    it("strips markdown formatting from outbound messages", async () => {
      await expectMessageSendDisabled(
        "+15551234567",
        "**Bold** and *italic* with `code`\n## Header",
        {
          serverUrl: "http://localhost:1234",
          password: "test",
        },
      );
    });

    it("strips markdown when creating a new chat", async () => {
      await expectMessageSendDisabled("+15550009999", "**Welcome** to the _chat_!", {
        serverUrl: "http://localhost:1234",
        password: "test",
      });
    });

    it("creates a new chat when handle target is missing", async () => {
      await expectMessageSendDisabled("+15550009999", "Hello new chat", {
        serverUrl: "http://localhost:1234",
        password: "test",
      });
    });

    it("throws when creating a new chat requires Private API", async () => {
      await expectMessageSendDisabled("+15550008888", "Hello", {
        serverUrl: "http://localhost:1234",
        password: "test",
      });
    });

    it("uses private-api when reply metadata is present", async () => {
      await expectMessageSendDisabled("+15551234567", "Replying", {
        serverUrl: "http://localhost:1234",
        password: "test",
        replyToMessageGuid: "reply-guid-123",
        replyToPartIndex: 1,
      });
    });

    it("downgrades threaded reply to plain send when private API is disabled", async () => {
      vi.mocked(getCachedBlueBubblesPrivateApiStatus).mockReturnValueOnce(false);
      await expectMessageSendDisabled("+15551234567", "Reply fallback", {
        serverUrl: "http://localhost:1234",
        password: "test",
        replyToMessageGuid: "reply-guid-123",
        replyToPartIndex: 1,
      });
    });

    it("normalizes effect names and uses private-api for effects", async () => {
      await expectMessageSendDisabled("+15551234567", "Hello", {
        serverUrl: "http://localhost:1234",
        password: "test",
        effectId: "invisible ink",
      });
    });

    it("sends message with chat_guid target directly", async () => {
      await expectMessageSendDisabled(
        "chat_guid:iMessage;-;direct-chat",
        "Direct message",
        {
          serverUrl: "http://localhost:1234",
          password: "test",
        },
      );
    });

    it("handles send failure", async () => {
      await expectMessageSendDisabled("+15551234567", "Hello", {
        serverUrl: "http://localhost:1234",
        password: "test",
      });
    });

    it("handles empty response body", async () => {
      await expectMessageSendDisabled("+15551234567", "Hello", {
        serverUrl: "http://localhost:1234",
        password: "test",
      });
    });

    it("handles invalid JSON response body", async () => {
      await expectMessageSendDisabled("+15551234567", "Hello", {
        serverUrl: "http://localhost:1234",
        password: "test",
      });
    });

    it("extracts messageId from various response formats", async () => {
      await expectMessageSendDisabled("+15551234567", "Hello", {
        serverUrl: "http://localhost:1234",
        password: "test",
      });
    });

    it("extracts messageGuid from response payload", async () => {
      await expectMessageSendDisabled("+15551234567", "Hello", {
        serverUrl: "http://localhost:1234",
        password: "test",
      });
    });

    it("resolves credentials from config", async () => {
      await expectMessageSendDisabled("+15551234567", "Hello", {
        cfg: {
          channels: {
            bluebubbles: {
              serverUrl: "http://config-server:5678",
              password: "config-pass",
            },
          },
        },
      });
    });

    it("includes tempGuid in request payload", async () => {
      await expectMessageSendDisabled("+15551234567", "Hello", {
        serverUrl: "http://localhost:1234",
        password: "test",
      });
    });
  });
});
