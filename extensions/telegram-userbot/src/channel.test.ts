import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import { telegramUserbotPlugin } from "./channel.js";

describe("telegramUserbotPlugin", () => {
  describe("meta", () => {
    it('has correct id "telegram-userbot"', () => {
      expect(telegramUserbotPlugin.id).toBe("telegram-userbot");
    });

    it("has required meta fields", () => {
      expect(telegramUserbotPlugin.meta.label).toBe("Telegram (User)");
      expect(telegramUserbotPlugin.meta.docsPath).toBe("/channels/telegram-userbot");
      expect(telegramUserbotPlugin.meta.blurb).toContain("MTProto");
    });
  });

  describe("capabilities", () => {
    it("supports direct messages", () => {
      expect(telegramUserbotPlugin.capabilities.chatTypes).toContain("direct");
    });

    it("supports group messages", () => {
      expect(telegramUserbotPlugin.capabilities.chatTypes).toContain("group");
    });

    it("supports text, photo, and document (media)", () => {
      expect(telegramUserbotPlugin.capabilities.media).toBe(true);
    });

    it("supports reactions", () => {
      expect(telegramUserbotPlugin.capabilities.reactions).toBe(true);
    });

    it("supports edit", () => {
      expect(telegramUserbotPlugin.capabilities.edit).toBe(true);
    });

    it("supports unsend (delete)", () => {
      expect(telegramUserbotPlugin.capabilities.unsend).toBe(true);
    });

    it("supports reply", () => {
      expect(telegramUserbotPlugin.capabilities.reply).toBe(true);
    });
  });

  describe("config adapter", () => {
    it("has required config functions", () => {
      expect(telegramUserbotPlugin.config.listAccountIds).toBeTypeOf("function");
      expect(telegramUserbotPlugin.config.resolveAccount).toBeTypeOf("function");
      expect(telegramUserbotPlugin.config.isConfigured).toBeTypeOf("function");
    });

    it("listAccountIds returns default when configured", () => {
      const cfg = {
        channels: {
          "telegram-userbot": {
            apiId: 12345,
            apiHash: "abc123",
          },
        },
      } as unknown as OpenClawConfig;
      const ids = telegramUserbotPlugin.config.listAccountIds(cfg);
      expect(ids).toContain("default");
    });

    it("listAccountIds returns default for empty config", () => {
      const cfg = { channels: {} } as unknown as OpenClawConfig;
      const ids = telegramUserbotPlugin.config.listAccountIds(cfg);
      expect(ids).toEqual(["default"]);
    });

    it("resolveAccount returns config details when configured", () => {
      const cfg = {
        channels: {
          "telegram-userbot": {
            apiId: 12345,
            apiHash: "abc123hash",
          },
        },
      } as unknown as OpenClawConfig;
      const account = telegramUserbotPlugin.config.resolveAccount(cfg);
      expect(account.apiId).toBe(12345);
      expect(account.apiHash).toBe("abc123hash");
      expect(account.configured).toBe(true);
    });

    it("resolveAccount returns unconfigured for missing apiId", () => {
      const cfg = {
        channels: {
          "telegram-userbot": {
            apiHash: "abc123hash",
          },
        },
      } as unknown as OpenClawConfig;
      const account = telegramUserbotPlugin.config.resolveAccount(cfg);
      expect(account.configured).toBe(false);
    });

    it("resolveAccount returns unconfigured for empty config", () => {
      const cfg = { channels: {} } as unknown as OpenClawConfig;
      const account = telegramUserbotPlugin.config.resolveAccount(cfg);
      expect(account.configured).toBe(false);
    });

    it("isConfigured returns true when apiId and apiHash are set", () => {
      const account = {
        accountId: "default",
        enabled: true,
        configured: true,
        apiId: 12345,
        apiHash: "abc",
        config: { apiId: 12345, apiHash: "abc" },
      };
      const cfg = {} as OpenClawConfig;
      expect(telegramUserbotPlugin.config.isConfigured!(account, cfg)).toBe(true);
    });

    it("resolveAllowFrom extracts allowFrom entries", () => {
      const cfg = {
        channels: {
          "telegram-userbot": {
            apiId: 12345,
            apiHash: "abc",
            allowFrom: [123456, "someuser"],
          },
        },
      } as unknown as OpenClawConfig;
      const result = telegramUserbotPlugin.config.resolveAllowFrom!({ cfg });
      expect(result).toEqual(["123456", "someuser"]);
    });

    it("formatAllowFrom strips channel prefix", () => {
      const result = telegramUserbotPlugin.config.formatAllowFrom!({
        cfg: {} as OpenClawConfig,
        allowFrom: ["telegram-userbot:12345", "67890"],
      });
      expect(result).toEqual(["12345", "67890"]);
    });
  });

  describe("security adapter", () => {
    it("has resolveDmPolicy function", () => {
      expect(telegramUserbotPlugin.security?.resolveDmPolicy).toBeTypeOf("function");
    });

    it("resolveDmPolicy returns allowlist policy by default", () => {
      const cfg = {
        channels: {
          "telegram-userbot": {
            apiId: 12345,
            apiHash: "abc",
            allowFrom: [111, 222],
          },
        },
      } as unknown as OpenClawConfig;
      const account = telegramUserbotPlugin.config.resolveAccount(cfg);
      const policy = telegramUserbotPlugin.security?.resolveDmPolicy?.({
        cfg,
        account,
      });
      expect(policy?.policy).toBe("allowlist");
      expect(policy?.allowFrom).toEqual([111, 222]);
    });

    it("collectWarnings warns when allowFrom is empty", async () => {
      const cfg = {
        channels: {
          "telegram-userbot": {
            apiId: 12345,
            apiHash: "abc",
          },
        },
      } as unknown as OpenClawConfig;
      const account = telegramUserbotPlugin.config.resolveAccount(cfg);
      const warnings = await telegramUserbotPlugin.security?.collectWarnings?.({
        cfg,
        account,
      });
      expect(warnings).toHaveLength(1);
      expect((warnings as string[])[0]).toContain("no allowFrom configured");
    });

    it("collectWarnings returns empty when allowFrom is set", async () => {
      const cfg = {
        channels: {
          "telegram-userbot": {
            apiId: 12345,
            apiHash: "abc",
            allowFrom: [123],
          },
        },
      } as unknown as OpenClawConfig;
      const account = telegramUserbotPlugin.config.resolveAccount(cfg);
      const warnings = await telegramUserbotPlugin.security?.collectWarnings?.({
        cfg,
        account,
      });
      expect(warnings).toHaveLength(0);
    });
  });

  describe("gateway", () => {
    it("has startAccount function", () => {
      expect(telegramUserbotPlugin.gateway?.startAccount).toBeTypeOf("function");
    });

    it("has stopAccount function", () => {
      expect(telegramUserbotPlugin.gateway?.stopAccount).toBeTypeOf("function");
    });
  });

  describe("pairing", () => {
    it("has id label for pairing", () => {
      expect(telegramUserbotPlugin.pairing?.idLabel).toBe("telegramUserbotSenderId");
    });

    it("normalizes telegram-userbot: prefix in allow entries", () => {
      const normalize = telegramUserbotPlugin.pairing?.normalizeAllowEntry;
      expect(normalize).toBeTypeOf("function");
      expect(normalize!("telegram-userbot:12345")).toBe("12345");
      expect(normalize!("67890")).toBe("67890");
    });
  });

  describe("messaging", () => {
    it("has target resolver", () => {
      expect(telegramUserbotPlugin.messaging?.targetResolver?.looksLikeId).toBeTypeOf("function");
    });

    it("recognizes numeric IDs as valid targets", () => {
      const looksLikeId = telegramUserbotPlugin.messaging?.targetResolver?.looksLikeId;
      expect(looksLikeId!("12345")).toBe(true);
    });

    it("recognizes @username as valid target", () => {
      const looksLikeId = telegramUserbotPlugin.messaging?.targetResolver?.looksLikeId;
      expect(looksLikeId!("@myuser")).toBe(true);
    });

    it("rejects invalid input", () => {
      const looksLikeId = telegramUserbotPlugin.messaging?.targetResolver?.looksLikeId;
      expect(looksLikeId!("")).toBe(false);
    });

    it("normalizeTarget strips channel prefix", () => {
      const normalize = telegramUserbotPlugin.messaging?.normalizeTarget;
      expect(normalize!("telegram-userbot:12345")).toBe("12345");
    });
  });

  describe("status", () => {
    it("has default runtime", () => {
      expect(telegramUserbotPlugin.status?.defaultRuntime).toBeDefined();
      expect(telegramUserbotPlugin.status?.defaultRuntime?.accountId).toBe("default");
      expect(telegramUserbotPlugin.status?.defaultRuntime?.running).toBe(false);
    });

    it("has buildAccountSnapshot function", () => {
      expect(telegramUserbotPlugin.status?.buildAccountSnapshot).toBeTypeOf("function");
    });

    it("has buildChannelSummary function", () => {
      expect(telegramUserbotPlugin.status?.buildChannelSummary).toBeTypeOf("function");
    });
  });

  describe("setup", () => {
    it("has applyAccountConfig function", () => {
      expect(telegramUserbotPlugin.setup?.applyAccountConfig).toBeTypeOf("function");
    });

    it("has resolveAccountId function", () => {
      expect(telegramUserbotPlugin.setup?.resolveAccountId).toBeTypeOf("function");
    });
  });

  describe("reload", () => {
    it("watches the correct config prefix", () => {
      expect(telegramUserbotPlugin.reload?.configPrefixes).toEqual(["channels.telegram-userbot"]);
    });
  });
});
