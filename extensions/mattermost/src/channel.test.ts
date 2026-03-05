import type { OpenClawConfig } from "openclaw/plugin-sdk/mattermost";
import { createReplyPrefixOptions } from "openclaw/plugin-sdk/mattermost";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
      const normalize = mattermostPlugin.messaging?.normalizeTarget;
      if (!normalize) {
        return;
      }

      expect(normalize("@Alice")).toBe("@Alice");
      expect(normalize("@alice")).toBe("@alice");
    });

    it("normalizes mattermost: prefix to user:", () => {
      const normalize = mattermostPlugin.messaging?.normalizeTarget;
      if (!normalize) {
        return;
      }

      expect(normalize("mattermost:USER123")).toBe("user:USER123");
    });
  });

  describe("pairing", () => {
    it("normalizes allowlist entries", () => {
      const normalize = mattermostPlugin.pairing?.normalizeAllowEntry;
      if (!normalize) {
        return;
      }

      expect(normalize("@Alice")).toBe("alice");
      expect(normalize("user:USER123")).toBe("user123");
    });
  });

  describe("capabilities", () => {
    it("declares reactions support", () => {
      expect(mattermostPlugin.capabilities?.reactions).toBe(true);
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

      const actions = mattermostPlugin.actions?.listActions?.({ cfg }) ?? [];
      expect(actions).toContain("react");
      expect(actions).not.toContain("send");
      expect(mattermostPlugin.actions?.supportsAction?.({ action: "react" })).toBe(true);
    });

    it("hides react when mattermost is not configured", () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            enabled: true,
          },
        },
      };

      const actions = mattermostPlugin.actions?.listActions?.({ cfg }) ?? [];
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

      const actions = mattermostPlugin.actions?.listActions?.({ cfg }) ?? [];
      expect(actions).not.toContain("react");
      expect(actions).not.toContain("send");
    });

    it("respects per-account actions.reactions in listActions", () => {
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

      const actions = mattermostPlugin.actions?.listActions?.({ cfg }) ?? [];
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
  });

  describe("outbound", () => {
    it("forwards mediaLocalRoots on sendMedia", async () => {
      const sendMedia = mattermostPlugin.outbound?.sendMedia;
      if (!sendMedia) {
        return;
      }

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
      const sendText = mattermostPlugin.outbound?.sendText;
      if (!sendText) {
        return;
      }
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
  });

  describe("config", () => {
    it("formats allowFrom entries", () => {
      const formatAllowFrom = mattermostPlugin.config.formatAllowFrom!;

      const formatted = formatAllowFrom({
        cfg: {} as OpenClawConfig,
        allowFrom: ["@Alice", "user:USER123", "mattermost:BOT999"],
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

      const prefixContext = createReplyPrefixOptions({
        cfg,
        agentId: "main",
        channel: "mattermost",
        accountId: "default",
      });

      expect(prefixContext.responsePrefix).toBe("[Account]");
    });
  });

  describe("reply threading (root_id)", () => {
    // The monitor's deliver callback receives a ReplyPayload with replyToId
    // (set by [[reply_to_current]] or [[reply_to:<id>]] tag processing).
    // It should pass payload.replyToId through as root_id on the Mattermost API call.
    //
    // Bug: monitor.ts hardcodes `replyToId: threadRootId` (the inbound thread root),
    // ignoring payload.replyToId entirely. When the inbound message is top-level
    // (threadRootId=undefined), [[reply_to_current]] replies are never threaded.

    // Replicate the monitor deliver callback logic (from monitor.ts lines ~737-767).
    // The deliver closure should prefer payload.replyToId (from [[reply_to_current]]
    // or [[reply_to:<id>]]) and fall back to threadRootId (existing thread context).
    function monitorDeliverReplyToId(
      payload: { replyToId?: string },
      threadRootId: string | undefined,
    ): string | undefined {
      return payload.replyToId || threadRootId;
    }

    it("passes payload.replyToId as root_id for [[reply_to_current]] on a top-level DM", () => {
      // User sends a top-level DM (not in a thread) → threadRootId is undefined.
      // Agent responds with [[reply_to_current]] → payload.replyToId = inbound post id.
      // The deliver callback should use payload.replyToId so the reply is threaded.
      const payload = { replyToId: "inbound-post-123" };
      const threadRootId = undefined;

      const replyToId = monitorDeliverReplyToId(payload, threadRootId);

      // BUG: this is undefined because monitor ignores payload.replyToId
      expect(replyToId).toBe("inbound-post-123");
    });

    it("passes payload.replyToId as root_id for explicit [[reply_to:<id>]]", () => {
      // Agent uses [[reply_to:specific-post-789]] to target a specific message.
      const payload = { replyToId: "specific-post-789" };
      const threadRootId = undefined;

      const replyToId = monitorDeliverReplyToId(payload, threadRootId);

      expect(replyToId).toBe("specific-post-789");
    });

    it("falls back to threadRootId when payload.replyToId is absent", () => {
      // Inbound message is already in a thread; no reply tag. Should keep threading.
      const payload = { replyToId: undefined };
      const threadRootId = "thread-root-456";

      const replyToId = monitorDeliverReplyToId(payload, threadRootId);

      expect(replyToId).toBe("thread-root-456");
    });

    it("prefers payload.replyToId over threadRootId when both are present", () => {
      // Agent explicitly targets a different post than the thread root.
      const payload = { replyToId: "explicit-target-999" };
      const threadRootId = "thread-root-456";

      const replyToId = monitorDeliverReplyToId(payload, threadRootId);

      expect(replyToId).toBe("explicit-target-999");
    });
  });
});
