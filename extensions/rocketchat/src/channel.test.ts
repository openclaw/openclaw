import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { createReplyPrefixOptions } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import { rocketchatPlugin } from "./channel.js";

describe("rocketchatPlugin", () => {
  describe("messaging", () => {
    it("keeps @username targets", () => {
      const normalize = rocketchatPlugin.messaging?.normalizeTarget;
      if (!normalize) {
        return;
      }

      expect(normalize("@Alice")).toBe("@Alice");
      expect(normalize("@alice")).toBe("@alice");
    });

    it("normalizes rocketchat: prefix to user:", () => {
      const normalize = rocketchatPlugin.messaging?.normalizeTarget;
      if (!normalize) {
        return;
      }

      expect(normalize("rocketchat:USER123")).toBe("user:USER123");
    });

    it("normalizes channel: prefix", () => {
      const normalize = rocketchatPlugin.messaging?.normalizeTarget;
      if (!normalize) {
        return;
      }

      expect(normalize("channel:GENERAL")).toBe("channel:GENERAL");
    });

    it("normalizes # prefix to channel:", () => {
      const normalize = rocketchatPlugin.messaging?.normalizeTarget;
      if (!normalize) {
        return;
      }

      expect(normalize("#general")).toBe("channel:general");
    });

    it("treats bare strings as channel ids", () => {
      const normalize = rocketchatPlugin.messaging?.normalizeTarget;
      if (!normalize) {
        return;
      }

      expect(normalize("GENERAL")).toBe("channel:GENERAL");
    });

    it("returns undefined for empty strings", () => {
      const normalize = rocketchatPlugin.messaging?.normalizeTarget;
      if (!normalize) {
        return;
      }

      expect(normalize("")).toBeUndefined();
      expect(normalize("  ")).toBeUndefined();
    });
  });

  describe("targetResolver", () => {
    it("recognizes rocketchat-style target ids", () => {
      const looksLike = rocketchatPlugin.messaging?.targetResolver?.looksLikeId;
      if (!looksLike) {
        return;
      }

      expect(looksLike("user:abc123")).toBe(true);
      expect(looksLike("channel:general")).toBe(true);
      expect(looksLike("rocketchat:USER123")).toBe(true);
      expect(looksLike("@alice")).toBe(true);
      expect(looksLike("#general")).toBe(true);
      expect(looksLike("abcdefghijklmnopqr")).toBe(true);
    });

    it("rejects empty and short strings", () => {
      const looksLike = rocketchatPlugin.messaging?.targetResolver?.looksLikeId;
      if (!looksLike) {
        return;
      }

      expect(looksLike("")).toBe(false);
      expect(looksLike("  ")).toBe(false);
    });
  });

  describe("pairing", () => {
    it("normalizes allowlist entries", () => {
      const normalize = rocketchatPlugin.pairing?.normalizeAllowEntry;
      if (!normalize) {
        return;
      }

      expect(normalize("@Alice")).toBe("alice");
      expect(normalize("user:USER123")).toBe("user123");
      expect(normalize("rocketchat:BOT999")).toBe("bot999");
    });
  });

  describe("config", () => {
    it("formats allowFrom entries", () => {
      const formatAllowFrom = rocketchatPlugin.config.formatAllowFrom;

      const formatted = formatAllowFrom({
        allowFrom: ["@Alice", "user:USER123", "rocketchat:BOT999"],
      });
      expect(formatted).toEqual(["@alice", "user123", "bot999"]);
    });

    it("uses account responsePrefix overrides", () => {
      const cfg: OpenClawConfig = {
        channels: {
          rocketchat: {
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
        channel: "rocketchat",
        accountId: "default",
      });

      expect(prefixContext.responsePrefix).toBe("[Account]");
    });

    it("reports configured when token, userId, and baseUrl present", () => {
      const isConfigured = rocketchatPlugin.config.isConfigured;
      expect(
        isConfigured({
          accountId: "default",
          enabled: true,
          authToken: "tok",
          userId: "uid",
          baseUrl: "https://chat.example.com",
          authTokenSource: "config",
          baseUrlSource: "config",
          config: {},
        } as any),
      ).toBe(true);
    });

    it("reports not configured when token missing", () => {
      const isConfigured = rocketchatPlugin.config.isConfigured;
      expect(
        isConfigured({
          accountId: "default",
          enabled: true,
          authToken: undefined,
          userId: "uid",
          baseUrl: "https://chat.example.com",
          authTokenSource: "none",
          baseUrlSource: "config",
          config: {},
        } as any),
      ).toBe(false);
    });
  });
});
