import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { createReplyPrefixOptions } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import { mattermostPlugin } from "./channel.js";
import { normalizeMention } from "./mattermost/monitor.js";

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

  describe("normalizeMention", () => {
    it("preserves newlines in multi-line messages with mention", () => {
      const input = "@bot line1\nline2\nline3";
      const result = normalizeMention(input, "bot");
      expect(result).toBe("line1\nline2\nline3");
    });

    it("preserves newlines in messages without mention", () => {
      const input = "line1\nline2\nline3";
      const result = normalizeMention(input, undefined);
      expect(result).toBe("line1\nline2\nline3");
    });

    it("collapses horizontal spaces around removed mention", () => {
      const input = "hello  @bot  world";
      const result = normalizeMention(input, "bot");
      expect(result).toBe("hello world");
    });

    it("removes mention at start of line", () => {
      const input = "@bot do something";
      const result = normalizeMention(input, "bot");
      expect(result).toBe("do something");
    });

    it("preserves Markdown block structure with mention", () => {
      const input = "@bot # Heading\n> quote\n- item";
      const result = normalizeMention(input, "bot");
      expect(result).toBe("# Heading\n> quote\n- item");
    });

    it("preserves CRLF newlines with mention", () => {
      const input = "@bot line1\r\nline2\r\nline3";
      const result = normalizeMention(input, "bot");
      expect(result).toBe("line1\r\nline2\r\nline3");
    });
  });

  describe("config", () => {
    it("formats allowFrom entries", () => {
      const formatAllowFrom = mattermostPlugin.config.formatAllowFrom;

      const formatted = formatAllowFrom({
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
