import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { createReplyPrefixOptions } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
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
