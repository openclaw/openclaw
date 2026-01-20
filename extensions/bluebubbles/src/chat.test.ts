import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { markBlueBubblesChatRead, sendBlueBubblesTyping } from "./chat.js";

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

const mockFetch = vi.fn();

describe("chat", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("markBlueBubblesChatRead", () => {
    it("does nothing when chatGuid is empty", async () => {
      await markBlueBubblesChatRead("", {
        serverUrl: "http://localhost:1234",
        password: "test",
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("does nothing when chatGuid is whitespace", async () => {
      await markBlueBubblesChatRead("   ", {
        serverUrl: "http://localhost:1234",
        password: "test",
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("throws when serverUrl is missing", async () => {
      await expect(markBlueBubblesChatRead("chat-guid", {})).rejects.toThrow(
        "serverUrl is required",
      );
    });

    it("throws when password is missing", async () => {
      await expect(
        markBlueBubblesChatRead("chat-guid", {
          serverUrl: "http://localhost:1234",
        }),
      ).rejects.toThrow("password is required");
    });

    it("marks chat as read successfully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await markBlueBubblesChatRead("iMessage;-;+15551234567", {
        serverUrl: "http://localhost:1234",
        password: "test-password",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/chat/iMessage%3B-%3B%2B15551234567/read"),
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("includes password in URL query", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await markBlueBubblesChatRead("chat-123", {
        serverUrl: "http://localhost:1234",
        password: "my-secret",
      });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("password=my-secret");
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve("Chat not found"),
      });

      await expect(
        markBlueBubblesChatRead("missing-chat", {
          serverUrl: "http://localhost:1234",
          password: "test",
        }),
      ).rejects.toThrow("read failed (404): Chat not found");
    });

    it("trims chatGuid before using", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await markBlueBubblesChatRead("  chat-with-spaces  ", {
        serverUrl: "http://localhost:1234",
        password: "test",
      });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("/api/v1/chat/chat-with-spaces/read");
      expect(calledUrl).not.toContain("%20chat");
    });

    it("resolves credentials from config", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await markBlueBubblesChatRead("chat-123", {
        cfg: {
          channels: {
            bluebubbles: {
              serverUrl: "http://config-server:9999",
              password: "config-pass",
            },
          },
        },
      });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("config-server:9999");
      expect(calledUrl).toContain("password=config-pass");
    });
  });

  describe("sendBlueBubblesTyping", () => {
    it("does nothing when chatGuid is empty", async () => {
      await sendBlueBubblesTyping("", true, {
        serverUrl: "http://localhost:1234",
        password: "test",
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("does nothing when chatGuid is whitespace", async () => {
      await sendBlueBubblesTyping("   ", false, {
        serverUrl: "http://localhost:1234",
        password: "test",
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("throws when serverUrl is missing", async () => {
      await expect(sendBlueBubblesTyping("chat-guid", true, {})).rejects.toThrow(
        "serverUrl is required",
      );
    });

    it("throws when password is missing", async () => {
      await expect(
        sendBlueBubblesTyping("chat-guid", true, {
          serverUrl: "http://localhost:1234",
        }),
      ).rejects.toThrow("password is required");
    });

    it("sends typing start with POST method", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await sendBlueBubblesTyping("iMessage;-;+15551234567", true, {
        serverUrl: "http://localhost:1234",
        password: "test",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/chat/iMessage%3B-%3B%2B15551234567/typing"),
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("sends typing stop with DELETE method", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await sendBlueBubblesTyping("iMessage;-;+15551234567", false, {
        serverUrl: "http://localhost:1234",
        password: "test",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/chat/iMessage%3B-%3B%2B15551234567/typing"),
        expect.objectContaining({ method: "DELETE" }),
      );
    });

    it("includes password in URL query", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await sendBlueBubblesTyping("chat-123", true, {
        serverUrl: "http://localhost:1234",
        password: "typing-secret",
      });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("password=typing-secret");
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal error"),
      });

      await expect(
        sendBlueBubblesTyping("chat-123", true, {
          serverUrl: "http://localhost:1234",
          password: "test",
        }),
      ).rejects.toThrow("typing failed (500): Internal error");
    });

    it("trims chatGuid before using", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await sendBlueBubblesTyping("  trimmed-chat  ", true, {
        serverUrl: "http://localhost:1234",
        password: "test",
      });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("/api/v1/chat/trimmed-chat/typing");
    });

    it("encodes special characters in chatGuid", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await sendBlueBubblesTyping("iMessage;+;group@chat.com", true, {
        serverUrl: "http://localhost:1234",
        password: "test",
      });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("iMessage%3B%2B%3Bgroup%40chat.com");
    });

    it("resolves credentials from config", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await sendBlueBubblesTyping("chat-123", true, {
        cfg: {
          channels: {
            bluebubbles: {
              serverUrl: "http://typing-server:8888",
              password: "typing-pass",
            },
          },
        },
      });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("typing-server:8888");
      expect(calledUrl).toContain("password=typing-pass");
    });

    it("can start and stop typing in sequence", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(""),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(""),
        });

      await sendBlueBubblesTyping("chat-123", true, {
        serverUrl: "http://localhost:1234",
        password: "test",
      });
      await sendBlueBubblesTyping("chat-123", false, {
        serverUrl: "http://localhost:1234",
        password: "test",
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0][1].method).toBe("POST");
      expect(mockFetch.mock.calls[1][1].method).toBe("DELETE");
    });
  });
});
