import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { createReplyPrefixOptions } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { mattermostPlugin } from "./channel.js";

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
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            enabled: true,
            botToken: "test-token",
            baseUrl: "https://chat.example.com",
          },
        },
      };

      const fetchImpl = vi.fn(async (url: any, init?: any) => {
        if (String(url).endsWith("/api/v4/users/me")) {
          return new Response(JSON.stringify({ id: "BOT123" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (String(url).endsWith("/api/v4/reactions")) {
          expect(init?.method).toBe("POST");
          expect(JSON.parse(init?.body)).toEqual({
            user_id: "BOT123",
            post_id: "POST1",
            emoji_name: "thumbsup",
          });
          return new Response(JSON.stringify({ ok: true }), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected url: ${url}`);
      });

      const prevFetch = globalThis.fetch;
      (globalThis as any).fetch = fetchImpl;
      try {
        const result = await mattermostPlugin.actions?.handleAction?.({
          channel: "mattermost",
          action: "react",
          params: { messageId: "POST1", emoji: "thumbsup" },
          cfg,
          accountId: "default",
        } as any);

        expect(result?.content).toEqual([
          { type: "text", text: "Reacted with :thumbsup: on POST1" },
        ]);
        expect(result?.details).toEqual({});
      } finally {
        (globalThis as any).fetch = prevFetch;
      }
    });

    it("only treats boolean remove flag as removal", async () => {
      const cfg: OpenClawConfig = {
        channels: {
          mattermost: {
            enabled: true,
            botToken: "test-token",
            baseUrl: "https://chat.example.com",
          },
        },
      };

      const fetchImpl = vi.fn(async (url: any, init?: any) => {
        if (String(url).endsWith("/api/v4/users/me")) {
          return new Response(JSON.stringify({ id: "BOT123" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (String(url).endsWith("/api/v4/reactions")) {
          expect(init?.method).toBe("POST");
          expect(JSON.parse(init?.body)).toEqual({
            user_id: "BOT123",
            post_id: "POST1",
            emoji_name: "thumbsup",
          });
          return new Response(JSON.stringify({ ok: true }), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected url: ${url}`);
      });

      const prevFetch = globalThis.fetch;
      (globalThis as any).fetch = fetchImpl;
      try {
        const result = await mattermostPlugin.actions?.handleAction?.({
          channel: "mattermost",
          action: "react",
          params: { messageId: "POST1", emoji: "thumbsup", remove: "true" },
          cfg,
          accountId: "default",
        } as any);

        expect(result?.content).toEqual([
          { type: "text", text: "Reacted with :thumbsup: on POST1" },
        ]);
      } finally {
        (globalThis as any).fetch = prevFetch;
      }
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
