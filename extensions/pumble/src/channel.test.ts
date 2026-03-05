import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import { pumblePlugin } from "./channel.js";

describe("pumblePlugin", () => {
  describe("messaging", () => {
    it("normalizes pumble: prefix to user:", () => {
      const normalize = pumblePlugin.messaging?.normalizeTarget;
      if (!normalize) {
        return;
      }
      expect(normalize("pumble:USER123")).toBe("user:USER123");
    });

    it("keeps channel: targets", () => {
      const normalize = pumblePlugin.messaging?.normalizeTarget;
      if (!normalize) {
        return;
      }
      expect(normalize("channel:CH123")).toBe("channel:CH123");
    });

    it("keeps user: targets", () => {
      const normalize = pumblePlugin.messaging?.normalizeTarget;
      if (!normalize) {
        return;
      }
      expect(normalize("user:U123")).toBe("user:U123");
    });

    it("normalizes # prefix to channel:", () => {
      const normalize = pumblePlugin.messaging?.normalizeTarget;
      if (!normalize) {
        return;
      }
      expect(normalize("#general")).toBe("channel:general");
    });

    it("treats email-like input as user:", () => {
      const normalize = pumblePlugin.messaging?.normalizeTarget;
      if (!normalize) {
        return;
      }
      expect(normalize("alice@example.com")).toBe("user:alice@example.com");
    });

    it("treats plain ID as channel:", () => {
      const normalize = pumblePlugin.messaging?.normalizeTarget;
      if (!normalize) {
        return;
      }
      expect(normalize("ABCDEF1234")).toBe("channel:ABCDEF1234");
    });
  });

  describe("targetResolver", () => {
    it("recognizes user: prefix", () => {
      const looksLikeId = pumblePlugin.messaging?.targetResolver?.looksLikeId;
      if (!looksLikeId) {
        return;
      }
      expect(looksLikeId("user:U123")).toBe(true);
    });

    it("recognizes channel: prefix", () => {
      const looksLikeId = pumblePlugin.messaging?.targetResolver?.looksLikeId;
      if (!looksLikeId) {
        return;
      }
      expect(looksLikeId("channel:CH123")).toBe(true);
    });

    it("recognizes pumble: prefix", () => {
      const looksLikeId = pumblePlugin.messaging?.targetResolver?.looksLikeId;
      if (!looksLikeId) {
        return;
      }
      expect(looksLikeId("pumble:U456")).toBe(true);
    });

    it("recognizes # prefix", () => {
      const looksLikeId = pumblePlugin.messaging?.targetResolver?.looksLikeId;
      if (!looksLikeId) {
        return;
      }
      expect(looksLikeId("#general")).toBe(true);
    });

    it("recognizes email addresses", () => {
      const looksLikeId = pumblePlugin.messaging?.targetResolver?.looksLikeId;
      if (!looksLikeId) {
        return;
      }
      expect(looksLikeId("alice@example.com")).toBe(true);
    });

    it("recognizes long alphanumeric IDs", () => {
      const looksLikeId = pumblePlugin.messaging?.targetResolver?.looksLikeId;
      if (!looksLikeId) {
        return;
      }
      expect(looksLikeId("ABCDEF1234")).toBe(true);
    });

    it("rejects short strings", () => {
      const looksLikeId = pumblePlugin.messaging?.targetResolver?.looksLikeId;
      if (!looksLikeId) {
        return;
      }
      expect(looksLikeId("hi")).toBe(false);
    });
  });

  describe("pairing", () => {
    it("normalizes allowlist entries", () => {
      const normalize = pumblePlugin.pairing?.normalizeAllowEntry;
      if (!normalize) {
        return;
      }
      expect(normalize("pumble:USER123")).toBe("user123");
      expect(normalize("user:USER123")).toBe("user123");
      expect(normalize("Alice")).toBe("alice");
    });
  });

  describe("capabilities", () => {
    it("declares thread support", () => {
      expect(pumblePlugin.capabilities?.threads).toBe(true);
    });

    it("declares reaction support", () => {
      expect(pumblePlugin.capabilities?.reactions).toBe(true);
    });

    it("declares media support", () => {
      expect(pumblePlugin.capabilities?.media).toBe(true);
    });

    it("declares direct and channel chat types", () => {
      expect(pumblePlugin.capabilities?.chatTypes).toContain("direct");
      expect(pumblePlugin.capabilities?.chatTypes).toContain("channel");
    });
  });

  describe("config", () => {
    it("lists default account when no accounts configured", () => {
      const cfg: OpenClawConfig = {
        channels: {
          pumble: {
            enabled: true,
            appId: "test-app-id",
            appKey: "test-app-key",
          },
        },
      };
      const ids = pumblePlugin.config.listAccountIds(cfg);
      expect(ids).toEqual(["default"]);
    });

    it("resolves account from base config", () => {
      const cfg: OpenClawConfig = {
        channels: {
          pumble: {
            enabled: true,
            appId: "test-app-id",
            appKey: "test-app-key",
          },
        },
      };
      const account = pumblePlugin.config.resolveAccount(cfg);
      expect(account.appId).toBe("test-app-id");
      expect(account.appKey).toBe("test-app-key");
      expect(account.enabled).toBe(true);
    });

    it("detects configured account", () => {
      const cfg: OpenClawConfig = {
        channels: {
          pumble: {
            enabled: true,
            appId: "test-app-id",
            appKey: "test-app-key",
          },
        },
      };
      const account = pumblePlugin.config.resolveAccount(cfg);
      expect(pumblePlugin.config.isConfigured?.(account, cfg)).toBe(true);
    });

    it("detects unconfigured account", () => {
      const cfg: OpenClawConfig = {
        channels: {
          pumble: {
            enabled: true,
          },
        },
      };
      const account = pumblePlugin.config.resolveAccount(cfg);
      expect(pumblePlugin.config.isConfigured?.(account, cfg)).toBe(false);
    });

    it("formats allowFrom entries", () => {
      const formatAllowFrom = pumblePlugin.config.formatAllowFrom!;
      const formatted = formatAllowFrom({
        cfg: {} as OpenClawConfig,
        allowFrom: ["pumble:USER123", "user:BOT999", "Alice"],
      });
      expect(formatted).toEqual(["user123", "bot999", "alice"]);
    });

    it("lists multi-account IDs sorted", () => {
      const cfg: OpenClawConfig = {
        channels: {
          pumble: {
            accounts: {
              beta: { appId: "b", appKey: "b" },
              alpha: { appId: "a", appKey: "a" },
            },
          },
        },
      };
      const ids = pumblePlugin.config.listAccountIds(cfg);
      expect(ids).toEqual(["alpha", "beta"]);
    });

    it("merges base config with account config", () => {
      const cfg: OpenClawConfig = {
        channels: {
          pumble: {
            appId: "base-id",
            appKey: "base-key",
            accounts: {
              prod: {
                appId: "prod-id",
              },
            },
          },
        },
      };
      const account = pumblePlugin.config.resolveAccount(cfg, "prod");
      expect(account.appId).toBe("prod-id");
      expect(account.appKey).toBe("base-key");
    });
  });

  describe("outbound", () => {
    it("rejects empty target", () => {
      const resolveTarget = pumblePlugin.outbound?.resolveTarget;
      if (!resolveTarget) {
        return;
      }
      const result = resolveTarget({ to: "" });
      expect(result.ok).toBe(false);
    });

    it("accepts valid target", () => {
      const resolveTarget = pumblePlugin.outbound?.resolveTarget;
      if (!resolveTarget) {
        return;
      }
      const result = resolveTarget({ to: "channel:CH123" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.to).toBe("channel:CH123");
      }
    });
  });

  describe("security", () => {
    it("resolves DM policy from account config", () => {
      const cfg: OpenClawConfig = {
        channels: {
          pumble: {
            enabled: true,
            appId: "test",
            appKey: "test",
            dmPolicy: "allowlist",
            allowFrom: ["user1"],
          },
        },
      };
      const account = pumblePlugin.config.resolveAccount(cfg);
      const dmPolicy = pumblePlugin.security?.resolveDmPolicy?.({
        cfg,
        accountId: account.accountId,
        account,
      });
      expect(dmPolicy?.policy).toBe("allowlist");
    });

    it("defaults DM policy to pairing", () => {
      const cfg: OpenClawConfig = {
        channels: {
          pumble: {
            enabled: true,
            appId: "test",
            appKey: "test",
          },
        },
      };
      const account = pumblePlugin.config.resolveAccount(cfg);
      const dmPolicy = pumblePlugin.security?.resolveDmPolicy?.({
        cfg,
        accountId: account.accountId,
        account,
      });
      expect(dmPolicy?.policy).toBe("pairing");
    });
  });

  describe("status", () => {
    it("builds snapshot for unconfigured account", async () => {
      const cfg: OpenClawConfig = {
        channels: {
          pumble: { enabled: true },
        },
      };
      const account = pumblePlugin.config.resolveAccount(cfg);
      const snapshot = await pumblePlugin.status?.buildAccountSnapshot?.({
        account,
        cfg,
        runtime: undefined,
        probe: undefined,
      });
      expect(snapshot?.configured).toBe(false);
      expect(snapshot?.running).toBe(false);
    });

    it("builds snapshot for configured account", async () => {
      const cfg: OpenClawConfig = {
        channels: {
          pumble: {
            enabled: true,
            appId: "test-id",
            appKey: "test-key",
          },
        },
      };
      const account = pumblePlugin.config.resolveAccount(cfg);
      const snapshot = await pumblePlugin.status?.buildAccountSnapshot?.({
        account,
        cfg,
        runtime: { running: true, connected: true } as never,
        probe: { ok: true } as never,
      });
      expect(snapshot?.configured).toBe(true);
      expect(snapshot?.running).toBe(true);
      expect(snapshot?.connected).toBe(true);
    });
  });
});
