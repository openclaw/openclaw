import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { createChannelReplyPipeline } from "../runtime-api.js";
const { sendMessageMattermostMock } = vi.hoisted(() => ({
  sendMessageMattermostMock: vi.fn(),
}));

vi.mock("./mattermost/send.js", () => ({
  sendMessageMattermost: sendMessageMattermostMock,
}));

import { mattermostPlugin } from "./channel.js";
import { resetMattermostReactionBotUserCacheForTests } from "./mattermost/reactions.js";
import {
  createMattermostReactionFetchMock,
  createMattermostTestConfig,
  withMockedGlobalFetch,
} from "./mattermost/reactions.test-helpers.js";

function getDescribedActions(cfg: OpenClawConfig): string[] {
  return [...(mattermostPlugin.actions?.describeMessageTool?.({ cfg })?.actions ?? [])];
}

function requireMattermostNormalizeTarget() {
  const normalize = mattermostPlugin.messaging?.normalizeTarget;
  if (!normalize) {
    throw new Error("mattermost messaging.normalizeTarget missing");
  }
  return normalize;
}

function requireMattermostPairingNormalizer() {
  const normalize = mattermostPlugin.pairing?.normalizeAllowEntry;
  if (!normalize) {
    throw new Error("mattermost pairing.normalizeAllowEntry missing");
  }
  return normalize;
}

function requireMattermostReplyToModeResolver() {
  const resolveReplyToMode = mattermostPlugin.threading?.resolveReplyToMode;
  if (!resolveReplyToMode) {
    throw new Error("mattermost threading.resolveReplyToMode missing");
  }
  return resolveReplyToMode;
}

function requireMattermostSendText() {
  const sendText = mattermostPlugin.outbound?.sendText;
  if (!sendText) {
    throw new Error("mattermost outbound.sendText missing");
  }
  return sendText;
}

function requireMattermostSendMedia() {
  const sendMedia = mattermostPlugin.outbound?.sendMedia;
  if (!sendMedia) {
    throw new Error("mattermost outbound.sendMedia missing");
  }
  return sendMedia;
}

describe("mattermostPlugin", () => {
  beforeEach(() => {
    sendMessageMattermostMock.mockReset();
    sendMessageMattermostMock.mockResolvedValue({
      messageId: "post-1",
      channelId: "channel-1",
    });
  });

  describe("messaging", () => {
    it("keeps @username targets", () => {
      const normalize = requireMattermostNormalizeTarget();

      expect(normalize("@Alice")).toBe("@Alice");
      expect(normalize("@alice")).toBe("@alice");
    });

    it("normalizes spaced mattermost prefixes to user targets", () => {
      const normalize = requireMattermostNormalizeTarget();

      expect(normalize("mattermost:USER123")).toBe("user:USER123");
      expect(normalize("  mattermost:USER123  ")).toBe("user:USER123");
    });
  });

  describe("pairing", () => {
    it("normalizes allowlist entries", () => {
      const normalize = requireMattermostPairingNormalizer();

      expect(normalize("@Alice")).toBe("alice");
      expect(normalize("user:USER123")).toBe("user123");
      expect(normalize("  @Alice  ")).toBe("alice");
      expect(normalize("  mattermost:USER123  ")).toBe("user123");
    });
  });

  describe("threading", () => {
    it("uses replyToMode for channel messages and keeps direct messages off", () => {
      const resolveReplyToMode = requireMattermostReplyToModeResolver();

      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            replyToMode: "all",
          },
        },
      };

      expect(
        resolveReplyToMode({
          cfg,
          accountId: "default",
          chatType: "channel",
        }),
      ).toBe("all");
      expect(
        resolveReplyToMode({
          cfg,
          accountId: "default",
          chatType: "direct",
        }),
      ).toBe("off");
    });
  });

  describe("messageActions", () => {
    beforeEach(() => {
      resetMattermostReactionBotUserCacheForTests();
    });

    const runReactAction = async (params: Record<string, unknown>, fetchMode: "add" | "remove") => {
      const cfg = createMattermostTestConfig();
      const fetchImpl = createMattermostReactionFetchMock({
        mode: fetchMode,
        postId: "POST1",
        emojiName: "thumbsup",
      });

      return await withMockedGlobalFetch(fetchImpl as unknown as typeof fetch, async () => {
        return await mattermostPlugin.actions?.handleAction?.({
          channel: "mattermost",
          action: "react",
          params,
          cfg,
          accountId: "default",
        } as any);
      });
    };

    it("exposes react when mattermost is configured", () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            enabled: true,
            botToken: "test-token",
            baseUrl: "https://chat.example.com",
          },
        },
      };

      const actions = getDescribedActions(cfg);
      expect(actions).toContain("react");
      expect(actions).toContain("send");
      expect(mattermostPlugin.actions?.supportsAction?.({ action: "react" })).toBe(true);
      expect(mattermostPlugin.actions?.supportsAction?.({ action: "send" })).toBe(true);
    });

    it("hides react when mattermost is not configured", () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            enabled: true,
          },
        },
      };

      const actions = getDescribedActions(cfg);
      expect(actions).toEqual([]);
    });

    it("hides react when actions.reactions is false", () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            enabled: true,
            botToken: "test-token",
            baseUrl: "https://chat.example.com",
            actions: { reactions: false },
          },
        },
      };

      const actions = getDescribedActions(cfg);
      expect(actions).not.toContain("react");
      expect(actions).toContain("send");
    });

    it("respects per-account actions.reactions in message discovery", () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            enabled: true,
            actions: { reactions: false },
            accounts: {
              default: {
                enabled: true,
                botToken: "test-token",
                baseUrl: "https://chat.example.com",
                actions: { reactions: true },
              },
            },
          },
        },
      };

      const actions = getDescribedActions(cfg);
      expect(actions).toContain("react");
    });

    it("blocks react when default account disables reactions and accountId is omitted", async () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            enabled: true,
            actions: { reactions: true },
            accounts: {
              default: {
                enabled: true,
                botToken: "test-token",
                baseUrl: "https://chat.example.com",
                actions: { reactions: false },
              },
            },
          },
        },
      };

      await expect(
        mattermostPlugin.actions?.handleAction?.({
          channel: "mattermost",
          action: "react",
          params: { messageId: "POST1", emoji: "thumbsup" },
          cfg,
        } as any),
      ).rejects.toThrow("Mattermost reactions are disabled in config");
    });

    it("handles react by calling Mattermost reactions API", async () => {
      const result = await runReactAction({ messageId: "POST1", emoji: "thumbsup" }, "add");

      expect(result?.content).toEqual([{ type: "text", text: "Reacted with :thumbsup: on POST1" }]);
      expect(result?.details).toEqual({});
    });

    it("only treats boolean remove flag as removal", async () => {
      const result = await runReactAction(
        { messageId: "POST1", emoji: "thumbsup", remove: "true" },
        "add",
      );

      expect(result?.content).toEqual([{ type: "text", text: "Reacted with :thumbsup: on POST1" }]);
    });

    it("removes reaction when remove flag is boolean true", async () => {
      const result = await runReactAction(
        { messageId: "POST1", emoji: "thumbsup", remove: true },
        "remove",
      );

      expect(result?.content).toEqual([
        { type: "text", text: "Removed reaction :thumbsup: from POST1" },
      ]);
      expect(result?.details).toEqual({});
    });

    it("maps replyTo to replyToId for send actions", async () => {
      const cfg = createMattermostTestConfig();

      await mattermostPlugin.actions?.handleAction?.({
        channel: "mattermost",
        action: "send",
        params: {
          to: "channel:CHAN1",
          message: "hello",
          replyTo: "post-root",
        },
        cfg,
        accountId: "default",
      } as any);

      expect(sendMessageMattermostMock).toHaveBeenCalledWith(
        "channel:CHAN1",
        "hello",
        expect.objectContaining({
          accountId: "default",
          replyToId: "post-root",
        }),
      );
    });

    it("falls back to trimmed replyTo when replyToId is blank", async () => {
      const cfg = createMattermostTestConfig();

      await mattermostPlugin.actions?.handleAction?.({
        channel: "mattermost",
        action: "send",
        params: {
          to: "channel:CHAN1",
          message: "hello",
          replyToId: "   ",
          replyTo: " post-root ",
        },
        cfg,
        accountId: "default",
      } as any);

      expect(sendMessageMattermostMock).toHaveBeenCalledWith(
        "channel:CHAN1",
        "hello",
        expect.objectContaining({
          accountId: "default",
          replyToId: "post-root",
        }),
      );
    });
  });

  describe("outbound", () => {
    it("forwards mediaLocalRoots on sendMedia", async () => {
      const sendMedia = requireMattermostSendMedia();

      await sendMedia({
        to: "channel:CHAN1",
        text: "hello",
        mediaUrl: "/tmp/workspace/image.png",
        mediaLocalRoots: ["/tmp/workspace"],
        accountId: "default",
        replyToId: "post-root",
      } as any);

      expect(sendMessageMattermostMock).toHaveBeenCalledWith(
        "channel:CHAN1",
        "hello",
        expect.objectContaining({
          mediaUrl: "/tmp/workspace/image.png",
          mediaLocalRoots: ["/tmp/workspace"],
        }),
      );
    });

    it("threads resolved cfg on sendText", async () => {
      const sendText = requireMattermostSendText();
      const cfg = {
        channels: {
          mattermost: {
            botToken: "resolved-bot-token",
            baseUrl: "https://chat.example.com",
          },
        },
      } as OpenClawConfig;

      await sendText({
        cfg,
        to: "channel:CHAN1",
        text: "hello",
        accountId: "default",
      } as any);

      expect(sendMessageMattermostMock).toHaveBeenCalledWith(
        "channel:CHAN1",
        "hello",
        expect.objectContaining({
          cfg,
          accountId: "default",
        }),
      );
    });

    it("uses threadId as fallback when replyToId is absent (sendText)", async () => {
      const sendText = requireMattermostSendText();

      await sendText({
        to: "channel:CHAN1",
        text: "hello",
        accountId: "default",
        threadId: "post-root",
      } as any);

      expect(sendMessageMattermostMock).toHaveBeenCalledWith(
        "channel:CHAN1",
        "hello",
        expect.objectContaining({
          accountId: "default",
          replyToId: "post-root",
        }),
      );
    });

    it("uses threadId as fallback when replyToId is absent (sendMedia)", async () => {
      const sendMedia = requireMattermostSendMedia();

      await sendMedia({
        to: "channel:CHAN1",
        text: "caption",
        mediaUrl: "https://example.com/image.png",
        accountId: "default",
        threadId: "post-root",
      } as any);

      expect(sendMessageMattermostMock).toHaveBeenCalledWith(
        "channel:CHAN1",
        "caption",
        expect.objectContaining({
          accountId: "default",
          replyToId: "post-root",
        }),
      );
    });
  });

  describe("config", () => {
    it("formats allowFrom entries", () => {
      const formatAllowFrom = mattermostPlugin.config.formatAllowFrom!;

      const formatted = formatAllowFrom({
        cfg: {} as OpenClawConfig,
        allowFrom: [" @Alice ", " user:USER123 ", " mattermost:BOT999 "],
      });
      expect(formatted).toEqual(["@alice", "user123", "bot999"]);
    });

    it("uses account responsePrefix overrides", () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            responsePrefix: "[Channel]",
            accounts: {
              default: { responsePrefix: "[Account]" },
            },
          },
        },
      };

      const prefixContext = createChannelReplyPipeline({
        cfg,
        agentId: "main",
        channel: "mattermost",
        accountId: "default",
      });

      expect(prefixContext.responsePrefix).toBe("[Account]");
    });
  });
});
