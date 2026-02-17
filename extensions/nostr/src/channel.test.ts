import { describe, expect, it } from "vitest";
import { resolveNostrSessionId, resolveNostrTimestampMs, nostrPlugin } from "./channel.js";

describe("nostrPlugin", () => {
  describe("meta", () => {
    it("has correct id", () => {
      expect(nostrPlugin.id).toBe("nostr");
    });

    it("has required meta fields", () => {
      expect(nostrPlugin.meta.label).toBe("Nostr");
      expect(nostrPlugin.meta.docsPath).toBe("/channels/nostr");
      expect(nostrPlugin.meta.blurb).toContain("NIP-63");
    });
  });

  describe("capabilities", () => {
    it("supports direct messages", () => {
      expect(nostrPlugin.capabilities.chatTypes).toContain("direct");
    });

    it("does not support groups (MVP)", () => {
      expect(nostrPlugin.capabilities.chatTypes).not.toContain("group");
    });

    it("does not support media (MVP)", () => {
      expect(nostrPlugin.capabilities.media).toBe(false);
    });
  });

  describe("config adapter", () => {
    it("has required config functions", () => {
      expect(nostrPlugin.config.listAccountIds).toBeTypeOf("function");
      expect(nostrPlugin.config.resolveAccount).toBeTypeOf("function");
      expect(nostrPlugin.config.isConfigured).toBeTypeOf("function");
    });

    it("listAccountIds returns empty array for unconfigured", () => {
      const cfg = { channels: {} };
      const ids = nostrPlugin.config.listAccountIds(cfg);
      expect(ids).toEqual([]);
    });

    it("listAccountIds returns default for configured", () => {
      const cfg = {
        channels: {
          nostr: {
            privateKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          },
        },
      };
      const ids = nostrPlugin.config.listAccountIds(cfg);
      expect(ids).toContain("default");
    });
  });

  describe("onboarding", () => {
    it("exposes onboarding adapter", () => {
      expect(nostrPlugin.onboarding).toBeTypeOf("object");
      expect(nostrPlugin.onboarding?.channel).toBe("nostr");
    });
  });

  describe("messaging", () => {
    it("has target resolver", () => {
      expect(nostrPlugin.messaging?.targetResolver?.looksLikeId).toBeTypeOf("function");
    });

    it("recognizes npub as valid target", () => {
      const looksLikeId = nostrPlugin.messaging?.targetResolver?.looksLikeId;
      if (!looksLikeId) {
        return;
      }

      expect(looksLikeId("npub1xyz123")).toBe(true);
    });

    it("recognizes hex pubkey as valid target", () => {
      const looksLikeId = nostrPlugin.messaging?.targetResolver?.looksLikeId;
      if (!looksLikeId) {
        return;
      }

      const hexPubkey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      expect(looksLikeId(hexPubkey)).toBe(true);
    });

    it("rejects invalid input", () => {
      const looksLikeId = nostrPlugin.messaging?.targetResolver?.looksLikeId;
      if (!looksLikeId) {
        return;
      }

      expect(looksLikeId("not-a-pubkey")).toBe(false);
      expect(looksLikeId("")).toBe(false);
    });

    it("normalizeTarget strips nostr: prefix", () => {
      const normalize = nostrPlugin.messaging?.normalizeTarget;
      if (!normalize) {
        return;
      }

      const hexPubkey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      expect(normalize(`nostr:${hexPubkey}`)).toBe(hexPubkey);
    });
  });

  describe("outbound", () => {
    it("has correct delivery mode", () => {
      expect(nostrPlugin.outbound?.deliveryMode).toBe("direct");
    });

    it("has reasonable text chunk limit", () => {
      expect(nostrPlugin.outbound?.textChunkLimit).toBe(4000);
    });
  });

  describe("pairing", () => {
    it("has id label for pairing", () => {
      expect(nostrPlugin.pairing?.idLabel).toBe("nostrPubkey");
    });

    it("normalizes nostr: prefix in allow entries", () => {
      const normalize = nostrPlugin.pairing?.normalizeAllowEntry;
      if (!normalize) {
        return;
      }

      const hexPubkey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      expect(normalize(`nostr:${hexPubkey}`)).toBe(hexPubkey);
    });
  });

  describe("security", () => {
    it("has resolveDmPolicy function", () => {
      expect(nostrPlugin.security?.resolveDmPolicy).toBeTypeOf("function");
    });
  });

  describe("session helpers", () => {
    it("uses explicit s-tag session id when provided", () => {
      expect(resolveNostrSessionId("ab".repeat(32), "ticket-123")).toBe("ticket-123");
    });

    it("uses lowercase sender pubkey for implicit sender session", () => {
      const uppercaseSender = "A".repeat(64);
      expect(resolveNostrSessionId(uppercaseSender, undefined)).toBe(
        `sender:${uppercaseSender.toLowerCase()}`,
      );
    });

    it("falls back to implicit sender session when explicit session is blank after trim", () => {
      expect(resolveNostrSessionId("a".repeat(64), "   ")).toBe(`sender:${"a".repeat(64)}`);
    });

    it("uses implicit sender session id when no s-tag is present", () => {
      expect(resolveNostrSessionId("a".repeat(64), undefined)).toBe(`sender:${"a".repeat(64)}`);
    });

    it("ignores whitespace around explicit session id", () => {
      expect(resolveNostrSessionId("a".repeat(64), "  ticket-123  ")).toBe("ticket-123");
    });

    it("normalizes Nostr created_at to milliseconds", () => {
      expect(resolveNostrTimestampMs(1_700_000_000)).toBe(1_700_000_000_000);
      expect(resolveNostrTimestampMs(0)).toBe(0);
    });
  });

  describe("gateway", () => {
    it("has startAccount function", () => {
      expect(nostrPlugin.gateway?.startAccount).toBeTypeOf("function");
    });
  });

  describe("status", () => {
    it("has default runtime", () => {
      expect(nostrPlugin.status?.defaultRuntime).toBeDefined();
      expect(nostrPlugin.status?.defaultRuntime?.accountId).toBe("default");
      expect(nostrPlugin.status?.defaultRuntime?.running).toBe(false);
    });

    it("has buildAccountSnapshot function", () => {
      expect(nostrPlugin.status?.buildAccountSnapshot).toBeTypeOf("function");
    });
  });
});
