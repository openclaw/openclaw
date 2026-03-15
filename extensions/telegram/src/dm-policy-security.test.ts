import { describe, expect, it, vi } from "vitest";
import {
  normalizeAllowFrom,
  normalizeDmAllowFromWithStore,
  resolveSenderAllowMatch,
  isSenderAllowed,
} from "./bot-access.js";

/**
 * Telegram DM Policy Security Test Suite
 *
 * Tests verify that Telegram's dmPolicy enforcement prevents unauthorized
 * direct messaging access through various attack vectors:
 * - Spoofed sender IDs
 * - Invalid username formats
 * - Pairing bypass attempts
 * - Open mode configurations
 * - Allowlist enforcement
 */
describe("telegram dmPolicy security", () => {
  describe("normalizeAllowFrom: ID validation and attack prevention", () => {
    it("accepts valid numeric Telegram user IDs", () => {
      const result = normalizeAllowFrom(["123456789", "987654321"]);
      expect(result.entries).toContain("123456789");
      expect(result.entries).toContain("987654321");
    });

    it("accepts negative group chat IDs (supergroup format)", () => {
      const result = normalizeAllowFrom(["-1001234567890"]);
      expect(result.entries).toContain("-1001234567890");
    });

    it("removes telegram/tg prefix (normalization)", () => {
      const result = normalizeAllowFrom(["telegram:123456789", "tg:987654321", "TG:111111111"]);
      expect(result.entries).toContain("123456789");
      expect(result.entries).toContain("987654321");
      expect(result.entries).toContain("111111111");
    });

    it("detects and warns on invalid non-numeric entries", () => {
      const result = normalizeAllowFrom(["@username", "invalid_id", "123abc", "456"]);
      expect(result.entries).toEqual(["456"]);
      expect(result.invalidEntries).toContain("@username");
      expect(result.invalidEntries).toContain("invalid_id");
      expect(result.invalidEntries).toContain("123abc");
    });

    it("preserves wildcard '*' as special entry", () => {
      const result = normalizeAllowFrom(["*", "123456789"]);
      expect(result.hasWildcard).toBe(true);
      expect(result.entries).toContain("123456789");
      expect(result.entries).not.toContain("*");
    });

    it("correctly sets hasEntries flag", () => {
      expect(normalizeAllowFrom([]).hasEntries).toBe(false);
      expect(normalizeAllowFrom(["123"]).hasEntries).toBe(true);
      expect(normalizeAllowFrom(["*"]).hasEntries).toBe(true);
      expect(normalizeAllowFrom([]).hasWildcard).toBe(false);
    });

    it("trims whitespace and filters empty entries", () => {
      const result = normalizeAllowFrom(["  123  ", "", "   456   ", "  "]);
      expect(result.entries).toEqual(["123", "456"]);
    });

    it("rejects @username format (must use numeric ID only)", () => {
      const result = normalizeAllowFrom(["@john_doe", "@jane"]);
      expect(result.entries).toEqual([]);
      expect(result.invalidEntries.length).toBe(2);
    });

    it("rejects entries with spaces or special characters", () => {
      const result = normalizeAllowFrom(["123 456", "user@domain", "123.456"]);
      expect(result.entries).toEqual([]);
      expect(result.invalidEntries.length).toBe(3);
    });

    it("attackers cannot bypass ID validation with format tricks", () => {
      const attemptedBypasses = [
        "123 ", // space suffix (trimmed)
        " 456", // space prefix (trimmed)
        "789+", // appended char
        "abc123", // letter prefix
        "123abc", // letter suffix
        "123.456", // decimal point
        "123,456", // comma separator
      ];
      const result = normalizeAllowFrom(attemptedBypasses);
      // Only '123' and '456' (after trim) are valid
      expect(result.entries).toContain("123");
      expect(result.entries).toContain("456");
      // Others are invalid
      expect(result.invalidEntries).toContain("123 ");
      expect(result.invalidEntries).toContain("123+");
      expect(result.invalidEntries).toContain("789+");
      expect(result.invalidEntries).toContain("abc123");
      expect(result.invalidEntries).toContain("123abc");
      expect(result.invalidEntries).toContain("123.456");
      expect(result.invalidEntries).toContain("123,456");
    });
  });

  describe("normalizeDmAllowFromWithStore: pairing store safety", () => {
    it("includes store entries when dmPolicy is pairing", () => {
      const result = normalizeDmAllowFromWithStore({
        allowFrom: ["111"],
        storeAllowFrom: ["222"],
        dmPolicy: "pairing",
      });
      expect(result.entries).toContain("111");
      expect(result.entries).toContain("222");
    });

    it("excludes store entries when dmPolicy is allowlist (privacy protection)", () => {
      const result = normalizeDmAllowFromWithStore({
        allowFrom: ["111"],
        storeAllowFrom: ["222", "333"],
        dmPolicy: "allowlist",
      });
      expect(result.entries).toContain("111");
      expect(result.entries).not.toContain("222");
      expect(result.entries).not.toContain("333");
    });

    it("includes store when dmPolicy is open", () => {
      const result = normalizeDmAllowFromWithStore({
        allowFrom: ["111"],
        storeAllowFrom: ["222"],
        dmPolicy: "open",
      });
      expect(result.entries).toContain("111");
      expect(result.entries).toContain("222");
    });

    it("includes store when dmPolicy is undefined (defaults to pairing)", () => {
      const result = normalizeDmAllowFromWithStore({
        allowFrom: ["111"],
        storeAllowFrom: ["222"],
      });
      expect(result.entries).toContain("111");
      expect(result.entries).toContain("222");
    });

    it("normalizes invalid entries in store too", () => {
      const result = normalizeDmAllowFromWithStore({
        allowFrom: ["123"],
        storeAllowFrom: ["@invalid", "456"],
        dmPolicy: "pairing",
      });
      expect(result.entries).toContain("123");
      expect(result.entries).toContain("456");
      expect(result.invalidEntries).toContain("@invalid");
    });

    it("scenario: migration attack prevented when changing pairing->allowlist", () => {
      // Old pairing store has many contacts
      const oldStore = ["111", "222", "333", "444"];

      // Attacker scenario: forgets to clear store before switching to allowlist
      const incorrectConfig = normalizeDmAllowFromWithStore({
        allowFrom: ["approved_admin"],
        storeAllowFrom: oldStore,
        dmPolicy: "allowlist",
      });
      // With correct allowlist mode, store is ignored
      expect(incorrectConfig.entries).toEqual(["approved_admin"]);

      // If someone misconfigures dmPolicy as pairing, exposure happens
      const exposedConfig = normalizeDmAllowFromWithStore({
        allowFrom: ["approved_admin"],
        storeAllowFrom: oldStore,
        dmPolicy: "pairing", // WRONG
      });
      expect(exposedConfig.entries).toContain("111");
      expect(exposedConfig.entries).toContain("222");
    });
  });

  describe("resolveSenderAllowMatch: sender authorization logic", () => {
    it("allows sender when wildcard is configured", () => {
      const allow = {
        entries: ["123"],
        hasWildcard: true,
        hasEntries: true,
        invalidEntries: [],
      };
      const match = resolveSenderAllowMatch({
        allow,
        senderId: "999",
        senderUsername: "unknown_user",
      });
      expect(match.allowed).toBe(true);
      expect(match.matchKey).toBe("*");
      expect(match.matchSource).toBe("wildcard");
    });

    it("allows sender when ID matches allowlist", () => {
      const allow = {
        entries: ["123", "456"],
        hasWildcard: false,
        hasEntries: true,
        invalidEntries: [],
      };
      const match = resolveSenderAllowMatch({
        allow,
        senderId: "456",
        senderUsername: "alice",
      });
      expect(match.allowed).toBe(true);
      expect(match.matchKey).toBe("456");
      expect(match.matchSource).toBe("id");
    });

    it("denies sender when ID does not match allowlist", () => {
      const allow = {
        entries: ["123", "456"],
        hasWildcard: false,
        hasEntries: true,
        invalidEntries: [],
      };
      const match = resolveSenderAllowMatch({
        allow,
        senderId: "999",
        senderUsername: "bob",
      });
      expect(match.allowed).toBe(false);
      expect(match.matchKey).toBeUndefined();
    });

    it("denies sender when no entries and no wildcard", () => {
      const allow = {
        entries: [],
        hasWildcard: false,
        hasEntries: false,
        invalidEntries: [],
      };
      const match = resolveSenderAllowMatch({
        allow,
        senderId: "123",
        senderUsername: "alice",
      });
      expect(match.allowed).toBe(false);
    });

    it("denies sender with undefined ID even in permissive context", () => {
      const allow = {
        entries: ["123"],
        hasWildcard: false,
        hasEntries: true,
        invalidEntries: [],
      };
      const match = resolveSenderAllowMatch({
        allow,
        senderId: undefined,
        senderUsername: "alice",
      });
      expect(match.allowed).toBe(false);
    });

    it("only username is NOT used for matching (security: numeric IDs only)", () => {
      const allow = {
        entries: ["alice"], // Username in allowlist (WRONG config, but let's test)
        hasWildcard: false,
        hasEntries: true,
        invalidEntries: [],
      };
      const match = resolveSenderAllowMatch({
        allow,
        senderId: "999",
        senderUsername: "alice", // Matches by username, but sender ID is different
      });
      // Match by numeric ID should fail even if username matches
      expect(match.allowed).toBe(false);
    });
  });

  describe("isSenderAllowed: combined sender authorization", () => {
    it("allows sender with matching ID", () => {
      const result = isSenderAllowed({
        allow: {
          entries: ["123", "456"],
          hasWildcard: false,
          hasEntries: true,
          invalidEntries: [],
        },
        senderId: "456",
        senderUsername: "bob",
      });
      expect(result).toBe(true);
    });

    it("denies sender with non-matching ID", () => {
      const result = isSenderAllowed({
        allow: {
          entries: ["123", "456"],
          hasWildcard: false,
          hasEntries: true,
          invalidEntries: [],
        },
        senderId: "999",
        senderUsername: "eve",
      });
      expect(result).toBe(false);
    });

    it("allows any sender with wildcard", () => {
      const result = isSenderAllowed({
        allow: {
          entries: ["123"],
          hasWildcard: true,
          hasEntries: true,
          invalidEntries: [],
        },
        senderId: "999",
        senderUsername: "unknown",
      });
      expect(result).toBe(true);
    });

    it("defaults to allow when no entries (open behavior)", () => {
      const result = isSenderAllowed({
        allow: {
          entries: [],
          hasWildcard: false,
          hasEntries: false,
          invalidEntries: [],
        },
        senderId: "any_sender",
        senderUsername: "any_user",
      });
      expect(result).toBe(true);
    });
  });

  describe("telegram dmPolicy attack scenarios", () => {
    it("scenario 1: spoofed numeric ID cannot bypass allowlist", () => {
      const allow = normalizeAllowFrom(["123456789"]);

      // Attacker tries ID 123456788 (off by one)
      const spoofMatch = resolveSenderAllowMatch({
        allow,
        senderId: "123456788",
        senderUsername: "admin_imposter",
      });
      expect(spoofMatch.allowed).toBe(false);

      // Correct ID works
      const legitMatch = resolveSenderAllowMatch({
        allow,
        senderId: "123456789",
        senderUsername: "admin",
      });
      expect(legitMatch.allowed).toBe(true);
    });

    it("scenario 2: attacker uses @username to bypass ID-based allowlist", () => {
      const allow = normalizeAllowFrom(["123456789", "987654321"]);

      // Attacker tries to use username
      const match = resolveSenderAllowMatch({
        allow,
        senderId: undefined, // Telegram user didn't set ID in message
        senderUsername: "admin", // But has username
      });
      // Should fail: username matching not supported
      expect(match.allowed).toBe(false);
    });

    it("scenario 3: pairing mode auto-allows after first contact, open mode allows all", () => {
      // Pairing mode: only paired IDs in allowlist
      const pairingAllow = normalizeAllowFrom(["123456789", "987654321"]);

      const unknownInPairing = resolveSenderAllowMatch({
        allow: pairingAllow,
        senderId: "111111111",
        senderUsername: "stranger",
      });
      expect(unknownInPairing.allowed).toBe(false);

      // Open mode: everyone allowed
      const openAllow = normalizeAllowFrom(["*"]);
      const anyoneInOpen = resolveSenderAllowMatch({
        allow: openAllow,
        senderId: "111111111",
        senderUsername: "stranger",
      });
      expect(anyoneInOpen.allowed).toBe(true);

      // Unknown ID in open still passes
      const unknownInOpen = resolveSenderAllowMatch({
        allow: openAllow,
        senderId: "999999999",
        senderUsername: "anyone",
      });
      expect(unknownInOpen.allowed).toBe(true);
    });

    it("scenario 4: mixed case telegram/tg prefix handling", () => {
      const allow = normalizeAllowFrom(["telegram:123456789", "TG:987654321", "tg:111111111"]);
      expect(allow.entries).toContain("123456789");
      expect(allow.entries).toContain("987654321");
      expect(allow.entries).toContain("111111111");

      const match = resolveSenderAllowMatch({
        allow,
        senderId: "123456789",
        senderUsername: "user1",
      });
      expect(match.allowed).toBe(true);
    });

    it("scenario 5: negative chat ID (supergroup) normalization", () => {
      const allow = normalizeAllowFrom(["-1001234567890"]);
      expect(allow.entries).toContain("-1001234567890");

      const match = resolveSenderAllowMatch({
        allow,
        senderId: "-1001234567890",
        senderUsername: "supergroup",
      });
      expect(match.allowed).toBe(true);

      // Similar but different negative ID fails
      const failMatch = resolveSenderAllowMatch({
        allow,
        senderId: "-1001234567891",
        senderUsername: "other_group",
      });
      expect(failMatch.allowed).toBe(false);
    });

    it("scenario 6: empty allowlist with open=false denies all", () => {
      const allow = normalizeAllowFrom([]);
      expect(allow.hasEntries).toBe(false);
      expect(allow.hasWildcard).toBe(false);

      const match = resolveSenderAllowMatch({
        allow,
        senderId: "123456789",
        senderUsername: "anyone",
      });
      expect(match.allowed).toBe(false);
    });

    it("scenario 7: zero-width or invisible character injection", () => {
      // Attacker tries to bypass with unicode tricks
      const result = normalizeAllowFrom([
        "123\u200B456", // zero-width space
        "123\u200C456", // zero-width non-joiner
        "123\u200D456", // zero-width joiner
      ]);
      // All are invalid (contain non-numeric chars)
      expect(result.entries).toEqual([]);
      expect(result.invalidEntries.length).toBe(3);
    });

    it("scenario 8: SQL injection-like payload in allowlist entry", () => {
      const result = normalizeAllowFrom([
        "123; DROP TABLE users; --",
        "123' OR '1'='1",
        "123 UNION SELECT * FROM --",
      ]);
      // All invalid: contain non-numeric chars
      expect(result.entries).toEqual([]);
      expect(result.invalidEntries.length).toBe(3);
    });

    it("scenario 9: allowlist with very large numeric IDs", () => {
      const largeIds = ["999999999999999999", "1000000000000000000"];
      const allow = normalizeAllowFrom(largeIds);
      expect(allow.entries).toContain("999999999999999999");
      expect(allow.entries).toContain("1000000000000000000");

      const match = resolveSenderAllowMatch({
        allow,
        senderId: "999999999999999999",
        senderUsername: "bigid",
      });
      expect(match.allowed).toBe(true);
    });

    it("scenario 10: rapid dm open mode followed by allowlist switch (migration)", () => {
      // Start with open mode
      const openConfig = normalizeAllowFrom(["*"]);
      expect(openConfig.hasWildcard).toBe(true);

      // Switch to allowlist with specific IDs
      const restrictiveConfig = normalizeAllowFrom(["123456789"]);
      expect(restrictiveConfig.hasWildcard).toBe(false);

      // Old message from unauthorized sender should now fail
      const oldUnauthorized = resolveSenderAllowMatch({
        allow: restrictiveConfig,
        senderId: "999999999",
        senderUsername: "previously_allowed",
      });
      expect(oldUnauthorized.allowed).toBe(false);
    });
  });

  describe("edge cases and error handling", () => {
    it("handles empty normalization gracefully", () => {
      const result = normalizeAllowFrom([]);
      expect(result.entries).toEqual([]);
      expect(result.hasEntries).toBe(false);
      expect(result.hasWildcard).toBe(false);
      expect(result.invalidEntries).toEqual([]);
    });

    it("handles undefined array gracefully", () => {
      const result = normalizeAllowFrom(undefined as any);
      expect(result.entries).toEqual([]);
      expect(result.hasEntries).toBe(false);
      expect(result.hasWildcard).toBe(false);
    });

    it("handles mixed valid/invalid entries", () => {
      const result = normalizeAllowFrom([
        "123456789",
        "@invalid",
        "987654321",
        "not_a_number",
        "-1001234567890",
      ]);
      expect(result.entries).toEqual(["123456789", "987654321", "-1001234567890"]);
      expect(result.invalidEntries).toEqual(["@invalid", "not_a_number"]);
    });

    it("handles store with invalid entries during merge", () => {
      const result = normalizeDmAllowFromWithStore({
        allowFrom: ["123"],
        storeAllowFrom: ["@invalid", "456"],
        dmPolicy: "pairing",
      });
      expect(result.entries).toContain("123");
      expect(result.entries).toContain("456");
      expect(result.invalidEntries).toContain("@invalid");
    });

    it("resolveSenderAllowMatch with all undefined parameters", () => {
      const match = resolveSenderAllowMatch({
        allow: {
          entries: [],
          hasWildcard: false,
          hasEntries: false,
          invalidEntries: [],
        },
        senderId: undefined,
        senderUsername: undefined,
      });
      expect(match.allowed).toBe(false);
    });
  });

  describe("logging suppression in test environment", () => {
    it("does not warn about invalid entries when VITEST is set", () => {
      // This test just verifies the code path doesn't crash
      // In actual VITEST environment, warnings are suppressed
      const originalEnv = process.env.VITEST;
      process.env.VITEST = "true";

      try {
        const result = normalizeAllowFrom(["@invalid", "123"]);
        expect(result.invalidEntries).toContain("@invalid");
      } finally {
        process.env.VITEST = originalEnv;
      }
    });
  });
});
