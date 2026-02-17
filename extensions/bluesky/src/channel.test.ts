import { describe, expect, it } from "vitest";
import { blueskyPlugin } from "./channel.js";

describe("blueskyPlugin", () => {
  describe("meta", () => {
    it("has correct id", () => {
      expect(blueskyPlugin.id).toBe("bluesky");
    });

    it("has required meta fields", () => {
      expect(blueskyPlugin.meta.label).toBe("Bluesky");
      expect(blueskyPlugin.meta.docsPath).toBe("/channels/bluesky");
      expect(blueskyPlugin.meta.blurb).toContain("AT Protocol");
    });
  });

  describe("capabilities", () => {
    it("supports direct messages", () => {
      expect(blueskyPlugin.capabilities.chatTypes).toContain("direct");
    });

    it("does not support groups (MVP)", () => {
      expect(blueskyPlugin.capabilities.chatTypes).not.toContain("group");
    });

    it("does not support media (MVP)", () => {
      expect(blueskyPlugin.capabilities.media).toBe(false);
    });
  });

  describe("config adapter", () => {
    it("has required config functions", () => {
      expect(blueskyPlugin.config.listAccountIds).toBeTypeOf("function");
      expect(blueskyPlugin.config.resolveAccount).toBeTypeOf("function");
      expect(blueskyPlugin.config.isConfigured).toBeTypeOf("function");
    });

    it("listAccountIds returns empty array for unconfigured", () => {
      const cfg = { channels: {} };
      const ids = blueskyPlugin.config.listAccountIds(cfg);
      expect(ids).toEqual([]);
    });

    it("listAccountIds returns default for configured", () => {
      const cfg = {
        channels: {
          bluesky: {
            identifier: "test.bsky.social",
            appPassword: "xxxx-xxxx-xxxx-xxxx",
          },
        },
      };
      const ids = blueskyPlugin.config.listAccountIds(cfg);
      expect(ids).toContain("default");
    });

    it("listAccountIds returns empty when only identifier is set", () => {
      const cfg = {
        channels: {
          bluesky: {
            identifier: "test.bsky.social",
          },
        },
      };
      const ids = blueskyPlugin.config.listAccountIds(cfg);
      expect(ids).toEqual([]);
    });
  });

  describe("messaging", () => {
    it("has target resolver", () => {
      expect(blueskyPlugin.messaging?.targetResolver?.looksLikeId).toBeTypeOf("function");
    });

    it("recognizes DID as valid target", () => {
      const looksLikeId = blueskyPlugin.messaging?.targetResolver?.looksLikeId;
      if (!looksLikeId) return;

      expect(looksLikeId("did:plc:z72i7hdynmk6r22z27h6tvur")).toBe(true);
      expect(looksLikeId("did:web:example.com")).toBe(true);
    });

    it("recognizes handle as valid target", () => {
      const looksLikeId = blueskyPlugin.messaging?.targetResolver?.looksLikeId;
      if (!looksLikeId) return;

      expect(looksLikeId("user.bsky.social")).toBe(true);
      expect(looksLikeId("@user.bsky.social")).toBe(true);
      expect(looksLikeId("example.com")).toBe(true);
    });

    it("rejects invalid input", () => {
      const looksLikeId = blueskyPlugin.messaging?.targetResolver?.looksLikeId;
      if (!looksLikeId) return;

      expect(looksLikeId("not-a-handle")).toBe(false);
      expect(looksLikeId("")).toBe(false);
      expect(looksLikeId("just-text")).toBe(false);
    });

    it("normalizeTarget strips @ prefix", () => {
      const normalize = blueskyPlugin.messaging?.normalizeTarget;
      if (!normalize) return;

      expect(normalize("@user.bsky.social")).toBe("user.bsky.social");
    });

    it("normalizeTarget preserves DID case", () => {
      const normalize = blueskyPlugin.messaging?.normalizeTarget;
      if (!normalize) return;

      expect(normalize("did:plc:ABC123")).toBe("did:plc:ABC123");
    });

    it("normalizeTarget lowercases handles", () => {
      const normalize = blueskyPlugin.messaging?.normalizeTarget;
      if (!normalize) return;

      expect(normalize("User.Bsky.Social")).toBe("user.bsky.social");
    });
  });

  describe("outbound", () => {
    it("has correct delivery mode", () => {
      expect(blueskyPlugin.outbound?.deliveryMode).toBe("direct");
    });

    it("has reasonable text chunk limit", () => {
      expect(blueskyPlugin.outbound?.textChunkLimit).toBe(10000);
    });
  });

  describe("pairing", () => {
    it("has id label for pairing", () => {
      expect(blueskyPlugin.pairing?.idLabel).toBe("blueskyDid");
    });

    it("normalizes @ prefix in allow entries", () => {
      const normalize = blueskyPlugin.pairing?.normalizeAllowEntry;
      if (!normalize) return;

      expect(normalize("@user.bsky.social")).toBe("user.bsky.social");
    });
  });

  describe("security", () => {
    it("has resolveDmPolicy function", () => {
      expect(blueskyPlugin.security?.resolveDmPolicy).toBeTypeOf("function");
    });
  });

  describe("gateway", () => {
    it("has startAccount function", () => {
      expect(blueskyPlugin.gateway?.startAccount).toBeTypeOf("function");
    });
  });

  describe("status", () => {
    it("has default runtime", () => {
      expect(blueskyPlugin.status?.defaultRuntime).toBeDefined();
      expect(blueskyPlugin.status?.defaultRuntime?.accountId).toBe("default");
      expect(blueskyPlugin.status?.defaultRuntime?.running).toBe(false);
    });

    it("has buildAccountSnapshot function", () => {
      expect(blueskyPlugin.status?.buildAccountSnapshot).toBeTypeOf("function");
    });
  });
});
