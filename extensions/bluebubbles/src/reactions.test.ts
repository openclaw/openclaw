import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { normalizeBlueBubblesReactionInput, sendBlueBubblesReaction } from "./reactions.js";

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

async function expectReactionDisabled(
  params: Parameters<typeof sendBlueBubblesReaction>[0],
): Promise<void> {
  await expect(sendBlueBubblesReaction(params)).rejects.toThrow("OPENCLAW_BLUEBUBBLES_OUTBOUND_ENABLED");
  expect(mockFetch).not.toHaveBeenCalled();
}

describe("reactions", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("sendBlueBubblesReaction", () => {
    it("throws when chatGuid is empty", async () => {
      await expect(
        sendBlueBubblesReaction({
          chatGuid: "",
          messageGuid: "msg-123",
          emoji: "love",
          opts: {
            serverUrl: "http://localhost:1234",
            password: "test",
          },
        }),
      ).rejects.toThrow("chatGuid");
    });

    it("throws when messageGuid is empty", async () => {
      await expect(
        sendBlueBubblesReaction({
          chatGuid: "chat-123",
          messageGuid: "",
          emoji: "love",
          opts: {
            serverUrl: "http://localhost:1234",
            password: "test",
          },
        }),
      ).rejects.toThrow("messageGuid");
    });

    it("throws when emoji is empty", async () => {
      await expect(
        sendBlueBubblesReaction({
          chatGuid: "chat-123",
          messageGuid: "msg-123",
          emoji: "",
          opts: {
            serverUrl: "http://localhost:1234",
            password: "test",
          },
        }),
      ).rejects.toThrow("emoji or name");
    });

    it("throws when serverUrl is missing", async () => {
      await expect(
        sendBlueBubblesReaction({
          chatGuid: "chat-123",
          messageGuid: "msg-123",
          emoji: "love",
          opts: {},
        }),
      ).rejects.toThrow("serverUrl is required");
    });

    it("throws when password is missing", async () => {
      await expect(
        sendBlueBubblesReaction({
          chatGuid: "chat-123",
          messageGuid: "msg-123",
          emoji: "love",
          opts: {
            serverUrl: "http://localhost:1234",
          },
        }),
      ).rejects.toThrow("password is required");
    });

    it("throws for unsupported reaction type", async () => {
      await expect(
        sendBlueBubblesReaction({
          chatGuid: "chat-123",
          messageGuid: "msg-123",
          emoji: "unsupported",
          opts: {
            serverUrl: "http://localhost:1234",
            password: "test",
          },
        }),
      ).rejects.toThrow("Unsupported BlueBubbles reaction");
    });

    describe("reaction type normalization", () => {
      const testCases = [
        { input: "love", expected: "love" },
        { input: "like", expected: "like" },
        { input: "dislike", expected: "dislike" },
        { input: "laugh", expected: "laugh" },
        { input: "emphasize", expected: "emphasize" },
        { input: "question", expected: "question" },
        { input: "heart", expected: "love" },
        { input: "thumbs_up", expected: "like" },
        { input: "thumbs-down", expected: "dislike" },
        { input: "thumbs_down", expected: "dislike" },
        { input: "haha", expected: "laugh" },
        { input: "lol", expected: "laugh" },
        { input: "emphasis", expected: "emphasize" },
        { input: "exclaim", expected: "emphasize" },
        { input: "❤️", expected: "love" },
        { input: "❤", expected: "love" },
        { input: "♥️", expected: "love" },
        { input: "😍", expected: "love" },
        { input: "👍", expected: "like" },
        { input: "👎", expected: "dislike" },
        { input: "😂", expected: "laugh" },
        { input: "🤣", expected: "laugh" },
        { input: "😆", expected: "laugh" },
        { input: "‼️", expected: "emphasize" },
        { input: "‼", expected: "emphasize" },
        { input: "❗", expected: "emphasize" },
        { input: "❓", expected: "question" },
        { input: "❔", expected: "question" },
        { input: "LOVE", expected: "love" },
        { input: "Like", expected: "like" },
      ];

      for (const { input, expected } of testCases) {
        it(`normalizes "${input}" to "${expected}"`, async () => {
          expect(normalizeBlueBubblesReactionInput(input)).toBe(expected);
          expect(mockFetch).not.toHaveBeenCalled();
        });
      }
    });

    it("sends reaction successfully", async () => {
      await expectReactionDisabled({
        chatGuid: "iMessage;-;+15551234567",
        messageGuid: "msg-uuid-123",
        emoji: "love",
        opts: {
          serverUrl: "http://localhost:1234",
          password: "test-password",
        },
      });
    });

    it("includes password in URL query", async () => {
      await expectReactionDisabled({
        chatGuid: "chat-123",
        messageGuid: "msg-123",
        emoji: "like",
        opts: {
          serverUrl: "http://localhost:1234",
          password: "my-react-password",
        },
      });
    });

    it("sends reaction removal with dash prefix", async () => {
      await expectReactionDisabled({
        chatGuid: "chat-123",
        messageGuid: "msg-123",
        emoji: "love",
        remove: true,
        opts: {
          serverUrl: "http://localhost:1234",
          password: "test",
        },
      });
      expect(normalizeBlueBubblesReactionInput("love", true)).toBe("-love");
    });

    it("strips leading dash from emoji when remove flag is set", async () => {
      await expectReactionDisabled({
        chatGuid: "chat-123",
        messageGuid: "msg-123",
        emoji: "-love",
        remove: true,
        opts: {
          serverUrl: "http://localhost:1234",
          password: "test",
        },
      });
      expect(normalizeBlueBubblesReactionInput("-love", true)).toBe("-love");
    });

    it("uses custom partIndex when provided", async () => {
      await expectReactionDisabled({
        chatGuid: "chat-123",
        messageGuid: "msg-123",
        emoji: "laugh",
        partIndex: 3,
        opts: {
          serverUrl: "http://localhost:1234",
          password: "test",
        },
      });
    });

    it("throws on non-ok response", async () => {
      await expectReactionDisabled({
        chatGuid: "chat-123",
        messageGuid: "msg-123",
        emoji: "like",
        opts: {
          serverUrl: "http://localhost:1234",
          password: "test",
        },
      });
    });

    it("resolves credentials from config", async () => {
      await expectReactionDisabled({
        chatGuid: "chat-123",
        messageGuid: "msg-123",
        emoji: "emphasize",
        opts: {
          cfg: {
            channels: {
              bluebubbles: {
                serverUrl: "http://react-server:7777",
                password: "react-pass",
              },
            },
          },
        },
      });
    });

    it("trims chatGuid and messageGuid", async () => {
      await expectReactionDisabled({
        chatGuid: "  chat-with-spaces  ",
        messageGuid: "  msg-with-spaces  ",
        emoji: "question",
        opts: {
          serverUrl: "http://localhost:1234",
          password: "test",
        },
      });
    });

    describe("reaction removal aliases", () => {
      it("handles emoji-based removal", async () => {
        await expectReactionDisabled({
          chatGuid: "chat-123",
          messageGuid: "msg-123",
          emoji: "👍",
          remove: true,
          opts: {
            serverUrl: "http://localhost:1234",
            password: "test",
          },
        });
        expect(normalizeBlueBubblesReactionInput("👍", true)).toBe("-like");
      });

      it("handles text alias removal", async () => {
        await expectReactionDisabled({
          chatGuid: "chat-123",
          messageGuid: "msg-123",
          emoji: "haha",
          remove: true,
          opts: {
            serverUrl: "http://localhost:1234",
            password: "test",
          },
        });
        expect(normalizeBlueBubblesReactionInput("haha", true)).toBe("-laugh");
      });
    });
  });
});
