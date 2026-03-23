import { describe, expect, it } from "vitest";
import { nostrPlugin } from "./channel.js";
import { TEST_HEX_PRIVATE_KEY, createConfiguredNostrCfg } from "./test-fixtures.js";

function requireNostrLooksLikeId() {
  const looksLikeId = nostrPlugin.messaging?.targetResolver?.looksLikeId;
  if (!looksLikeId) {
    throw new Error("nostr messaging.targetResolver.looksLikeId missing");
  }
  return looksLikeId;
}

function requireNostrNormalizeTarget() {
  const normalize = nostrPlugin.messaging?.normalizeTarget;
  if (!normalize) {
    throw new Error("nostr messaging.normalizeTarget missing");
  }
  return normalize;
}

function requireNostrPairingNormalizer() {
  const normalize = nostrPlugin.pairing?.normalizeAllowEntry;
  if (!normalize) {
    throw new Error("nostr pairing.normalizeAllowEntry missing");
  }
  return normalize;
}

function requireNostrResolveDmPolicy() {
  const resolveDmPolicy = nostrPlugin.security?.resolveDmPolicy;
  if (!resolveDmPolicy) {
    throw new Error("nostr security.resolveDmPolicy missing");
  }
  return resolveDmPolicy;
}

describe("nostrPlugin", () => {
  describe("meta", () => {
    it("has correct id", () => {
      expect(nostrPlugin.id).toBe("nostr");
    });

    it("has required meta fields", () => {
      expect(nostrPlugin.meta.label).toBe("Nostr");
      expect(nostrPlugin.meta.docsPath).toBe("/channels/nostr");
      expect(nostrPlugin.meta.blurb).toContain("NIP-04");
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
    it("listAccountIds returns empty array for unconfigured", () => {
      const cfg = { channels: {} };
      const ids = nostrPlugin.config.listAccountIds(cfg);
      expect(ids).toEqual([]);
    });

    it("listAccountIds returns default for configured", () => {
      const cfg = createConfiguredNostrCfg();
      const ids = nostrPlugin.config.listAccountIds(cfg);
      expect(ids).toContain("default");
    });
  });

  describe("messaging", () => {
    it("recognizes npub as valid target", () => {
      const looksLikeId = requireNostrLooksLikeId();

      expect(looksLikeId("npub1xyz123")).toBe(true);
    });

    it("recognizes hex pubkey as valid target", () => {
      const looksLikeId = requireNostrLooksLikeId();

      expect(looksLikeId(TEST_HEX_PRIVATE_KEY)).toBe(true);
    });

    it("rejects invalid input", () => {
      const looksLikeId = requireNostrLooksLikeId();

      expect(looksLikeId("not-a-pubkey")).toBe(false);
      expect(looksLikeId("")).toBe(false);
    });

    it("normalizeTarget strips spaced nostr prefixes", () => {
      const normalize = requireNostrNormalizeTarget();

      expect(normalize(`nostr:${TEST_HEX_PRIVATE_KEY}`)).toBe(TEST_HEX_PRIVATE_KEY);
      expect(normalize(`  nostr:${TEST_HEX_PRIVATE_KEY}  `)).toBe(TEST_HEX_PRIVATE_KEY);
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

    it("normalizes spaced nostr prefixes in allow entries", () => {
      const normalize = requireNostrPairingNormalizer();

      expect(normalize(`nostr:${TEST_HEX_PRIVATE_KEY}`)).toBe(TEST_HEX_PRIVATE_KEY);
      expect(normalize(`  nostr:${TEST_HEX_PRIVATE_KEY}  `)).toBe(TEST_HEX_PRIVATE_KEY);
    });
  });

  describe("security", () => {
    it("normalizes dm allowlist entries through the dm policy adapter", () => {
      const resolveDmPolicy = requireNostrResolveDmPolicy();

      const cfg = createConfiguredNostrCfg({
        dmPolicy: "allowlist",
        allowFrom: [`  nostr:${TEST_HEX_PRIVATE_KEY}  `],
      });
      const account = nostrPlugin.config.resolveAccount(cfg, "default");

      const result = resolveDmPolicy({ cfg, account });
      if (!result) {
        throw new Error("nostr resolveDmPolicy returned null");
      }

      expect(result.policy).toBe("allowlist");
      expect(result.allowFrom).toEqual([`  nostr:${TEST_HEX_PRIVATE_KEY}  `]);
      expect(result.normalizeEntry?.(`  nostr:${TEST_HEX_PRIVATE_KEY}  `)).toBe(
        TEST_HEX_PRIVATE_KEY,
      );
    });
  });

  describe("status", () => {
    it("has default runtime", () => {
      expect(nostrPlugin.status?.defaultRuntime).toEqual({
        accountId: "default",
        running: false,
        lastStartAt: null,
        lastStopAt: null,
        lastError: null,
      });
    });
  });
});
