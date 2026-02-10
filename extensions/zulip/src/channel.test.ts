import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { createReplyPrefixOptions } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import { zulipPlugin } from "./channel.js";
import { resolveZulipAccount } from "./zulip/accounts.js";

describe("zulipPlugin", () => {
  describe("messaging", () => {
    it("normalizes @username targets", () => {
      const normalize = zulipPlugin.messaging?.normalizeTarget;
      if (!normalize) {
        return;
      }

      expect(normalize("@Alice")).toBe("user:Alice");
      expect(normalize("@alice")).toBe("user:alice");
    });

    it("normalizes zulip: prefix to user:", () => {
      const normalize = zulipPlugin.messaging?.normalizeTarget;
      if (!normalize) {
        return;
      }

      expect(normalize("zulip:USER123")).toBe("user:USER123");
    });
  });

  describe("pairing", () => {
    it("normalizes allowlist entries", () => {
      const normalize = zulipPlugin.pairing?.normalizeAllowEntry;
      if (!normalize) {
        return;
      }

      expect(normalize("@Alice")).toBe("alice");
      expect(normalize("user:USER123")).toBe("user123");
    });
  });

  describe("config", () => {
    it("formats allowFrom entries", () => {
      const formatAllowFrom = zulipPlugin.config.formatAllowFrom;

      const formatted = formatAllowFrom({
        allowFrom: ["@Alice", "user:USER123", "zulip:BOT999"],
      });
      expect(formatted).toEqual(["@alice", "user123", "bot999"]);
    });

    it("uses account responsePrefix overrides", () => {
      const cfg: OpenClawConfig = {
        channels: {
          zulip: {
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
        channel: "zulip",
        accountId: "default",
      });

      expect(prefixContext.responsePrefix).toBe("[Account]");
    });

    it("prefers account-level site/realm aliases over base-level url", () => {
      const cfg: OpenClawConfig = {
        channels: {
          zulip: {
            url: "https://base.example.com",
            accounts: {
              default: {
                site: "https://account.example.com",
                realm: "https://account-realm.example.com",
              },
            },
          },
        },
      };

      const account = resolveZulipAccount({ cfg, accountId: "default" });
      expect(account.baseUrl).toBe("https://account.example.com");
    });

    it("falls back to base-level aliases when account has no url aliases", () => {
      const cfg: OpenClawConfig = {
        channels: {
          zulip: {
            site: "https://base-site.example.com",
            accounts: {
              default: {
                name: "Primary",
              },
            },
          },
        },
      };

      const account = resolveZulipAccount({ cfg, accountId: "default" });
      expect(account.baseUrl).toBe("https://base-site.example.com");
    });
  });
});
