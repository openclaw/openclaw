import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { createReplyPrefixOptions } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mattermostPlugin } from "./channel.js";
import { resetMattermostReactionBotUserCacheForTests } from "./mattermost/reactions.js";
import {
  createMattermostReactionFetchMock,
  createMattermostTestConfig,
  withMockedGlobalFetch,
} from "./mattermost/reactions.test-helpers.js";

describe("mattermostPlugin", () => {
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

    // --- read action tests ---

    it("exposes read when mattermost is configured", () => {
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
      expect(actions).toContain("read");
      expect(mattermostPlugin.actions?.supportsAction?.({ action: "read" })).toBe(true);
    });

    it("hides read when actions.messages is false", () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            enabled: true,
            botToken: "test-token",
            baseUrl: "https://chat.example.com",
            actions: { messages: false },
          },
        },
      };

      const actions = mattermostPlugin.actions?.listActions?.({ cfg }) ?? [];
      expect(actions).not.toContain("read");
    });

    it("respects per-account actions.messages in listActions", () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            enabled: true,
            actions: { messages: false },
            accounts: {
              default: {
                enabled: true,
                botToken: "test-token",
                baseUrl: "https://chat.example.com",
                actions: { messages: true },
              },
            },
          },
        },
      };

      const actions = mattermostPlugin.actions?.listActions?.({ cfg }) ?? [];
      expect(actions).toContain("read");
    });

    it("blocks read when messages are disabled in config", async () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            enabled: true,
            actions: { messages: true },
            accounts: {
              default: {
                enabled: true,
                botToken: "test-token",
                baseUrl: "https://chat.example.com",
                actions: { messages: false },
              },
            },
          },
        },
      };

      await expect(
        mattermostPlugin.actions?.handleAction?.({
          channel: "mattermost",
          action: "read",
          params: { channelId: "CH1" },
          cfg,
        } as any),
      ).rejects.toThrow("Mattermost message reads are disabled in config");
    });

    it("throws when channelId is missing for read", async () => {
      const cfg = createMattermostTestConfig();
      const fetchMock = vi.fn();

      await expect(
        withMockedGlobalFetch(fetchMock as unknown as typeof fetch, async () => {
          return await mattermostPlugin.actions?.handleAction?.({
            channel: "mattermost",
            action: "read",
            params: {},
            cfg,
            accountId: "default",
          } as any);
        }),
      ).rejects.toThrow("Mattermost read requires channelId or to");
    });

    it("handles read action and returns messages JSON", async () => {
      const postsData = {
        order: ["p1"],
        posts: { p1: { id: "p1", user_id: "u1", message: "hi", create_at: 1000 } },
      };
      const fetchMock = vi.fn(async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes("/posts")) {
          return new Response(JSON.stringify(postsData), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (urlStr.includes("/users/u1")) {
          return new Response(JSON.stringify({ id: "u1", username: "alice" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const cfg = createMattermostTestConfig();
      const result = await withMockedGlobalFetch(fetchMock as unknown as typeof fetch, async () => {
        return await mattermostPlugin.actions?.handleAction?.({
          channel: "mattermost",
          action: "read",
          params: { channelId: "CH1" },
          cfg,
          accountId: "default",
        } as any);
      });

      expect(result?.content).toHaveLength(1);
      const first = result!.content[0] as { type: string; text: string };
      const parsed = JSON.parse(first.text);
      expect(parsed.ok).toBe(true);
      expect(parsed.messages).toHaveLength(1);
      expect(parsed.messages[0]).toMatchObject({
        id: "p1",
        username: "alice",
        message: "hi",
      });
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
