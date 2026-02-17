import { describe, expect, it } from "vitest";
import { xmtpPlugin } from "./channel.js";

describe("xmtpPlugin", () => {
  describe("meta", () => {
    it("has correct id", () => {
      expect(xmtpPlugin.id).toBe("xmtp");
    });

    it("has required meta fields", () => {
      expect(xmtpPlugin.meta.label).toBe("XMTP");
      expect(xmtpPlugin.meta.docsPath).toBe("/channels/xmtp");
      expect(xmtpPlugin.meta.blurb).toContain("E2E encrypted");
    });
  });

  describe("capabilities", () => {
    it("supports direct messages", () => {
      expect(xmtpPlugin.capabilities.chatTypes).toContain("direct");
    });

    it("does not support groups (Phase 1)", () => {
      expect(xmtpPlugin.capabilities.chatTypes).not.toContain("group");
    });

    it("does not support media (Phase 1)", () => {
      expect(xmtpPlugin.capabilities.media).toBe(false);
    });
  });

  describe("config adapter", () => {
    it("has required config functions", () => {
      expect(xmtpPlugin.config.listAccountIds).toBeTypeOf("function");
      expect(xmtpPlugin.config.resolveAccount).toBeTypeOf("function");
      expect(xmtpPlugin.config.isConfigured).toBeTypeOf("function");
    });

    it("listAccountIds returns empty array for unconfigured", () => {
      // #given
      const cfg = { channels: {} };

      // #when
      const ids = xmtpPlugin.config.listAccountIds(cfg);

      // #then
      expect(ids).toEqual([]);
    });

    it("listAccountIds returns default for configured", () => {
      // #given
      const cfg = {
        channels: {
          xmtp: {
            walletKey: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            dbEncryptionKey: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          },
        },
      };

      // #when
      const ids = xmtpPlugin.config.listAccountIds(cfg);

      // #then
      expect(ids).toContain("default");
    });

    it("isConfigured returns false without walletKey", async () => {
      // #given
      const cfg = { channels: {} };
      const account = xmtpPlugin.config.resolveAccount(cfg, "default");
      const isConfigured = xmtpPlugin.config.isConfigured;
      if (!isConfigured) return;

      // #then
      expect(await isConfigured(account, cfg)).toBe(false);
    });

    it("isConfigured returns false without dbEncryptionKey", async () => {
      // #given
      const cfg = {
        channels: {
          xmtp: {
            walletKey: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          },
        },
      };
      const account = xmtpPlugin.config.resolveAccount(cfg, "default");
      const isConfigured = xmtpPlugin.config.isConfigured;
      if (!isConfigured) return;

      // #then
      expect(await isConfigured(account, cfg)).toBe(false);
    });
  });

  describe("messaging", () => {
    it("has target resolver", () => {
      expect(xmtpPlugin.messaging?.targetResolver?.looksLikeId).toBeTypeOf("function");
    });

    it("recognizes Ethereum address as valid target", () => {
      // #given
      const looksLikeId = xmtpPlugin.messaging?.targetResolver?.looksLikeId;
      if (!looksLikeId) return;

      // #then
      expect(looksLikeId("0x1234567890abcdef1234567890abcdef12345678")).toBe(true);
    });

    it("rejects invalid input", () => {
      // #given
      const looksLikeId = xmtpPlugin.messaging?.targetResolver?.looksLikeId;
      if (!looksLikeId) return;

      // #then
      expect(looksLikeId("not-an-address")).toBe(false);
      expect(looksLikeId("")).toBe(false);
      expect(looksLikeId("0x1234")).toBe(false);
    });

    it("normalizeTarget lowercases address", () => {
      // #given
      const normalize = xmtpPlugin.messaging?.normalizeTarget;
      if (!normalize) return;

      // #then
      expect(normalize("0x1234567890ABCDEF1234567890ABCDEF12345678")).toBe(
        "0x1234567890abcdef1234567890abcdef12345678",
      );
    });
  });

  describe("outbound", () => {
    it("has correct delivery mode", () => {
      expect(xmtpPlugin.outbound?.deliveryMode).toBe("direct");
    });

    it("has reasonable text chunk limit", () => {
      expect(xmtpPlugin.outbound?.textChunkLimit).toBe(4000);
    });
  });

  describe("pairing", () => {
    it("has id label for pairing", () => {
      expect(xmtpPlugin.pairing?.idLabel).toBe("ethAddress");
    });

    it("normalizes Ethereum addresses in allow entries", () => {
      // #given
      const normalize = xmtpPlugin.pairing?.normalizeAllowEntry;
      if (!normalize) return;

      // #then
      expect(normalize("0x1234567890ABCDEF1234567890ABCDEF12345678")).toBe(
        "0x1234567890abcdef1234567890abcdef12345678",
      );
    });
  });

  describe("security", () => {
    it("has resolveDmPolicy function", () => {
      expect(xmtpPlugin.security?.resolveDmPolicy).toBeTypeOf("function");
    });
  });

  describe("gateway", () => {
    it("has startAccount function", () => {
      expect(xmtpPlugin.gateway?.startAccount).toBeTypeOf("function");
    });
  });

  describe("status", () => {
    it("has default runtime", () => {
      expect(xmtpPlugin.status?.defaultRuntime).toBeDefined();
      expect(xmtpPlugin.status?.defaultRuntime?.accountId).toBe("default");
      expect(xmtpPlugin.status?.defaultRuntime?.running).toBe(false);
    });

    it("has buildAccountSnapshot function", () => {
      expect(xmtpPlugin.status?.buildAccountSnapshot).toBeTypeOf("function");
    });
  });
});
