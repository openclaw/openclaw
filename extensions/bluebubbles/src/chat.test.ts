import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { markBlueBubblesChatRead, sendBlueBubblesTyping, setGroupIconBlueBubbles } from "./chat.js";
import { getCachedBlueBubblesPrivateApiStatus } from "./probe.js";

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

describe("chat", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
    vi.mocked(getCachedBlueBubblesPrivateApiStatus).mockReset();
    vi.mocked(getCachedBlueBubblesPrivateApiStatus).mockReturnValue(null);
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

    it("does not send read receipt when private API is disabled", async () => {
      vi.mocked(getCachedBlueBubblesPrivateApiStatus).mockReturnValueOnce(false);

      await markBlueBubblesChatRead("iMessage;-;+15551234567", {
        serverUrl: "http://localhost:1234",
        password: "test-password",
      });

      expect(mockFetch).not.toHaveBeenCalled();
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

    it("does not send typing when private API is disabled", async () => {
      vi.mocked(getCachedBlueBubblesPrivateApiStatus).mockReturnValueOnce(false);

      await sendBlueBubblesTyping("iMessage;-;+15551234567", true, {
        serverUrl: "http://localhost:1234",
        password: "test",
      });

      expect(mockFetch).not.toHaveBeenCalled();
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

  describe("setGroupIconBlueBubbles", () => {
    it("throws when chatGuid is empty", async () => {
      await expect(
        setGroupIconBlueBubbles("", new Uint8Array([1, 2, 3]), "icon.png", {
          serverUrl: "http://localhost:1234",
          password: "test",
        }),
      ).rejects.toThrow("chatGuid");
    });

    it("throws when buffer is empty", async () => {
      await expect(
        setGroupIconBlueBubbles("chat-guid", new Uint8Array(0), "icon.png", {
          serverUrl: "http://localhost:1234",
          password: "test",
        }),
      ).rejects.toThrow("image buffer");
    });

    it("throws when serverUrl is missing", async () => {
      await expect(
        setGroupIconBlueBubbles("chat-guid", new Uint8Array([1, 2, 3]), "icon.png", {}),
      ).rejects.toThrow("serverUrl is required");
    });

    it("throws when password is missing", async () => {
      await expect(
        setGroupIconBlueBubbles("chat-guid", new Uint8Array([1, 2, 3]), "icon.png", {
          serverUrl: "http://localhost:1234",
        }),
      ).rejects.toThrow("password is required");
    });

    it("throws when private API is disabled", async () => {
      vi.mocked(getCachedBlueBubblesPrivateApiStatus).mockReturnValueOnce(false);
      await expect(
        setGroupIconBlueBubbles("chat-guid", new Uint8Array([1, 2, 3]), "icon.png", {
          serverUrl: "http://localhost:1234",
          password: "test",
        }),
      ).rejects.toThrow("requires Private API");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("sets group icon successfully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      const buffer = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
      await setGroupIconBlueBubbles("iMessage;-;chat-guid", buffer, "icon.png", {
        serverUrl: "http://localhost:1234",
        password: "test-password",
        contentType: "image/png",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/chat/iMessage%3B-%3Bchat-guid/icon"),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": expect.stringContaining("multipart/form-data"),
          }),
        }),
      );
    });

    it("includes password in URL query", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await setGroupIconBlueBubbles("chat-123", new Uint8Array([1, 2, 3]), "icon.png", {
        serverUrl: "http://localhost:1234",
        password: "my-secret",
      });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("password=my-secret");
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal error"),
      });

      await expect(
        setGroupIconBlueBubbles("chat-123", new Uint8Array([1, 2, 3]), "icon.png", {
          serverUrl: "http://localhost:1234",
          password: "test",
        }),
      ).rejects.toThrow("setGroupIcon failed (500): Internal error");
    });

    it("trims chatGuid before using", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await setGroupIconBlueBubbles("  chat-with-spaces  ", new Uint8Array([1]), "icon.png", {
        serverUrl: "http://localhost:1234",
        password: "test",
      });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("/api/v1/chat/chat-with-spaces/icon");
      expect(calledUrl).not.toContain("%20chat");
    });

    it("resolves credentials from config", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await setGroupIconBlueBubbles("chat-123", new Uint8Array([1]), "icon.png", {
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

    it("includes filename in multipart body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(""),
      });

      await setGroupIconBlueBubbles("chat-123", new Uint8Array([1, 2, 3]), "custom-icon.jpg", {
        serverUrl: "http://localhost:1234",
        password: "test",
        contentType: "image/jpeg",
      });

      const body = mockFetch.mock.calls[0][1].body as Uint8Array;
      const bodyString = new TextDecoder().decode(body);
      expect(bodyString).toContain('filename="custom-icon.jpg"');
      expect(bodyString).toContain("image/jpeg");
    });
  });
});
