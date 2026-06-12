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

async function expectChatOutboundDisabled(action: () => Promise<unknown>): Promise<void> {
  await expect(action()).rejects.toThrow("OPENCLAW_BLUEBUBBLES_OUTBOUND_ENABLED");
  expect(mockFetch).not.toHaveBeenCalled();
}

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
      await expectChatOutboundDisabled(() =>
        markBlueBubblesChatRead("iMessage;-;+15551234567", {
          serverUrl: "http://localhost:1234",
          password: "test-password",
        }),
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
      await expectChatOutboundDisabled(() =>
        markBlueBubblesChatRead("chat-123", {
          serverUrl: "http://localhost:1234",
          password: "my-secret",
        }),
      );
    });

    it("throws on non-ok response", async () => {
      await expectChatOutboundDisabled(() =>
        markBlueBubblesChatRead("missing-chat", {
          serverUrl: "http://localhost:1234",
          password: "test",
        }),
      );
    });

    it("trims chatGuid before using", async () => {
      await expectChatOutboundDisabled(() =>
        markBlueBubblesChatRead("  chat-with-spaces  ", {
          serverUrl: "http://localhost:1234",
          password: "test",
        }),
      );
    });

    it("resolves credentials from config", async () => {
      await expectChatOutboundDisabled(() =>
        markBlueBubblesChatRead("chat-123", {
          cfg: {
            channels: {
              bluebubbles: {
                serverUrl: "http://config-server:9999",
                password: "config-pass",
              },
            },
          },
        }),
      );
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
      await expectChatOutboundDisabled(() =>
        sendBlueBubblesTyping("iMessage;-;+15551234567", true, {
          serverUrl: "http://localhost:1234",
          password: "test",
        }),
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
      await expectChatOutboundDisabled(() =>
        sendBlueBubblesTyping("iMessage;-;+15551234567", false, {
          serverUrl: "http://localhost:1234",
          password: "test",
        }),
      );
    });

    it("includes password in URL query", async () => {
      await expectChatOutboundDisabled(() =>
        sendBlueBubblesTyping("chat-123", true, {
          serverUrl: "http://localhost:1234",
          password: "typing-secret",
        }),
      );
    });

    it("throws on non-ok response", async () => {
      await expectChatOutboundDisabled(() =>
        sendBlueBubblesTyping("chat-123", true, {
          serverUrl: "http://localhost:1234",
          password: "test",
        }),
      );
    });

    it("trims chatGuid before using", async () => {
      await expectChatOutboundDisabled(() =>
        sendBlueBubblesTyping("  trimmed-chat  ", true, {
          serverUrl: "http://localhost:1234",
          password: "test",
        }),
      );
    });

    it("encodes special characters in chatGuid", async () => {
      await expectChatOutboundDisabled(() =>
        sendBlueBubblesTyping("iMessage;+;group@chat.com", true, {
          serverUrl: "http://localhost:1234",
          password: "test",
        }),
      );
    });

    it("resolves credentials from config", async () => {
      await expectChatOutboundDisabled(() =>
        sendBlueBubblesTyping("chat-123", true, {
          cfg: {
            channels: {
              bluebubbles: {
                serverUrl: "http://typing-server:8888",
                password: "typing-pass",
              },
            },
          },
        }),
      );
    });

    it("can start and stop typing in sequence", async () => {
      await expectChatOutboundDisabled(() =>
        sendBlueBubblesTyping("chat-123", true, {
          serverUrl: "http://localhost:1234",
          password: "test",
        }),
      );
      await expectChatOutboundDisabled(() =>
        sendBlueBubblesTyping("chat-123", false, {
          serverUrl: "http://localhost:1234",
          password: "test",
        }),
      );
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
      const buffer = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
      await expectChatOutboundDisabled(() =>
        setGroupIconBlueBubbles("iMessage;-;chat-guid", buffer, "icon.png", {
          serverUrl: "http://localhost:1234",
          password: "test-password",
          contentType: "image/png",
        }),
      );
    });

    it("includes password in URL query", async () => {
      await expectChatOutboundDisabled(() =>
        setGroupIconBlueBubbles("chat-123", new Uint8Array([1, 2, 3]), "icon.png", {
          serverUrl: "http://localhost:1234",
          password: "my-secret",
        }),
      );
    });

    it("throws on non-ok response", async () => {
      await expectChatOutboundDisabled(() =>
        setGroupIconBlueBubbles("chat-123", new Uint8Array([1, 2, 3]), "icon.png", {
          serverUrl: "http://localhost:1234",
          password: "test",
        }),
      );
    });

    it("trims chatGuid before using", async () => {
      await expectChatOutboundDisabled(() =>
        setGroupIconBlueBubbles("  chat-with-spaces  ", new Uint8Array([1]), "icon.png", {
          serverUrl: "http://localhost:1234",
          password: "test",
        }),
      );
    });

    it("resolves credentials from config", async () => {
      await expectChatOutboundDisabled(() =>
        setGroupIconBlueBubbles("chat-123", new Uint8Array([1]), "icon.png", {
          cfg: {
            channels: {
              bluebubbles: {
                serverUrl: "http://config-server:9999",
                password: "config-pass",
              },
            },
          },
        }),
      );
    });

    it("includes filename in multipart body", async () => {
      await expectChatOutboundDisabled(() =>
        setGroupIconBlueBubbles("chat-123", new Uint8Array([1, 2, 3]), "custom-icon.jpg", {
          serverUrl: "http://localhost:1234",
          password: "test",
          contentType: "image/jpeg",
        }),
      );
    });
  });
});
