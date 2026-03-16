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

  describe("threading", () => {
    it("uses replyToMode for channel messages and keeps direct messages off", () => {
      const resolveReplyToMode = mattermostPlugin.threading?.resolveReplyToMode;
      if (!resolveReplyToMode) {
        return;
      }

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

    const runPostAction = async (params: {
      action: "edit" | "delete";
      input: Record<string, unknown>;
      responseBody?: unknown;
      status?: number;
    }) => {
      const cfg = createMattermostTestConfig();
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      const status = params.status ?? (params.action === "delete" ? 204 : 200);
      const responseBody =
        params.responseBody ?? (params.action === "edit" ? { id: "POST1" } : null);
      const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        calls.push({ url: urlStr, init });

        return responseBody === null
          ? new Response(null, { status })
          : new Response(JSON.stringify(responseBody), {
              status,
              headers: { "content-type": "application/json" },
            });
      });

      const result = await withMockedGlobalFetch(fetchImpl as unknown as typeof fetch, async () => {
        return await mattermostPlugin.actions?.handleAction?.({
          channel: "mattermost",
          action: params.action,
          params: params.input,
          cfg,
          accountId: "default",
        } as any);
      });

      return { calls, result };
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
      expect(actions).toContain("send");
      expect(actions).toContain("edit");
      expect(actions).toContain("delete");
      expect(mattermostPlugin.actions?.supportsAction?.({ action: "react" })).toBe(true);
      expect(mattermostPlugin.actions?.supportsAction?.({ action: "send" })).toBe(true);
      expect(mattermostPlugin.actions?.supportsAction?.({ action: "edit" })).toBe(true);
      expect(mattermostPlugin.actions?.supportsAction?.({ action: "delete" })).toBe(true);
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

    it("keeps send, edit, and delete when actions.reactions is false", () => {
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
      expect(actions).toEqual(["send", "edit", "delete"]);
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

    it("handles edit by patching the Mattermost post", async () => {
      const { calls, result } = await runPostAction({
        action: "edit",
        input: { messageId: "POST1", message: "updated message" },
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://chat.example.com/api/v4/posts/POST1/patch");
      expect(calls[0]?.init?.method).toBe("PUT");
      expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ message: "updated message" });
      expect(result?.content).toEqual([{ type: "text", text: "Edited post POST1" }]);
      expect(result?.details).toEqual({ postId: "POST1" });
    });

    it("accepts message_id aliases when editing posts", async () => {
      const { calls, result } = await runPostAction({
        action: "edit",
        input: { message_id: "POST1", message: "updated message" },
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://chat.example.com/api/v4/posts/POST1/patch");
      expect(result?.content).toEqual([{ type: "text", text: "Edited post POST1" }]);
      expect(result?.details).toEqual({ postId: "POST1" });
    });

    it("handles delete by deleting the Mattermost post", async () => {
      const { calls, result } = await runPostAction({
        action: "delete",
        input: { messageId: "POST1" },
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://chat.example.com/api/v4/posts/POST1");
      expect(calls[0]?.init?.method).toBe("DELETE");
      expect(result?.content).toEqual([{ type: "text", text: "Deleted post POST1" }]);
      expect(result?.details).toEqual({});
    });

    it("accepts message_id aliases when deleting posts", async () => {
      const { calls, result } = await runPostAction({
        action: "delete",
        input: { message_id: "POST1" },
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://chat.example.com/api/v4/posts/POST1");
      expect(calls[0]?.init?.method).toBe("DELETE");
      expect(result?.content).toEqual([{ type: "text", text: "Deleted post POST1" }]);
      expect(result?.details).toEqual({});
    });

    it("rejects whitespace-only edit content before calling Mattermost", async () => {
      const cfg = createMattermostTestConfig();
      const fetchImpl = vi.fn();

      await expect(
        withMockedGlobalFetch(fetchImpl as unknown as typeof fetch, async () => {
          return await mattermostPlugin.actions?.handleAction?.({
            channel: "mattermost",
            action: "edit",
            params: { messageId: "POST1", message: "   " },
            cfg,
            accountId: "default",
          } as any);
        }),
      ).rejects.toThrow("Mattermost edit requires message text");

      expect(fetchImpl).not.toHaveBeenCalled();
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

    it("uses threadId as fallback when replyToId is absent (sendText)", async () => {
      const sendText = mattermostPlugin.outbound?.sendText;
      if (!sendText) {
        return;
      }

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
      const sendMedia = mattermostPlugin.outbound?.sendMedia;
      if (!sendMedia) {
        return;
      }

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
});
