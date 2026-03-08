import { describe, it, expect } from "vitest";
import { checkSenderAccess } from "./access-control.js";

describe("checkSenderAccess", () => {
  describe("open policy", () => {
    it("allows any sender", () => {
      const result = checkSenderAccess("anyone@example.com", "open", []);
      expect(result.allowed).toBe(true);
    });

    it("allows even with an empty allowFrom list", () => {
      const result = checkSenderAccess("stranger@evil.com", "open", []);
      expect(result.allowed).toBe(true);
    });
  });

  describe("pairing policy (treated as allowlist)", () => {
    it("allows exact email match", () => {
      const result = checkSenderAccess(
        "alice@example.com",
        "pairing",
        ["alice@example.com"],
      );
      expect(result.allowed).toBe(true);
    });

    it("rejects sender not in allowFrom", () => {
      const result = checkSenderAccess(
        "stranger@evil.com",
        "pairing",
        ["alice@example.com"],
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("not in the allowlist");
    });

    it("matches case-insensitively", () => {
      const result = checkSenderAccess(
        "Alice@Example.COM",
        "pairing",
        ["alice@example.com"],
      );
      expect(result.allowed).toBe(true);
    });

    it("handles allowFrom entries with mixed case", () => {
      const result = checkSenderAccess(
        "alice@example.com",
        "pairing",
        ["Alice@Example.COM"],
      );
      expect(result.allowed).toBe(true);
    });

    it("matches domain wildcard *@example.com", () => {
      const result = checkSenderAccess(
        "bob@example.com",
        "pairing",
        ["*@example.com"],
      );
      expect(result.allowed).toBe(true);
    });

    it("rejects sender from different domain with wildcard", () => {
      const result = checkSenderAccess(
        "bob@other.com",
        "pairing",
        ["*@example.com"],
      );
      expect(result.allowed).toBe(false);
    });

    it("domain wildcard is case-insensitive", () => {
      const result = checkSenderAccess(
        "bob@Example.COM",
        "pairing",
        ["*@example.com"],
      );
      expect(result.allowed).toBe(true);
    });

    it("rejects when allowFrom is empty", () => {
      const result = checkSenderAccess("alice@example.com", "pairing", []);
      expect(result.allowed).toBe(false);
    });

    it("handles numeric entries in allowFrom gracefully", () => {
      const result = checkSenderAccess(
        "alice@example.com",
        "pairing",
        [12345, "alice@example.com"],
      );
      expect(result.allowed).toBe(true);
    });

    it("handles numeric-only allowFrom without crashing", () => {
      const result = checkSenderAccess(
        "alice@example.com",
        "pairing",
        [12345, 67890],
      );
      expect(result.allowed).toBe(false);
    });
  });

  describe("closed policy", () => {
    it("allows exact match", () => {
      const result = checkSenderAccess(
        "alice@example.com",
        "closed",
        ["alice@example.com"],
      );
      expect(result.allowed).toBe(true);
    });

    it("rejects unlisted sender", () => {
      const result = checkSenderAccess(
        "stranger@evil.com",
        "closed",
        ["alice@example.com"],
      );
      expect(result.allowed).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("rejects empty sender address", () => {
      const result = checkSenderAccess("", "pairing", ["alice@example.com"]);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Empty sender");
    });

    it("handles whitespace in sender", () => {
      const result = checkSenderAccess(
        "  alice@example.com  ",
        "pairing",
        ["alice@example.com"],
      );
      expect(result.allowed).toBe(true);
    });

    it("handles whitespace in allowFrom entries", () => {
      const result = checkSenderAccess(
        "alice@example.com",
        "pairing",
        ["  alice@example.com  "],
      );
      expect(result.allowed).toBe(true);
    });

    it("skips empty string entries in allowFrom", () => {
      const result = checkSenderAccess(
        "alice@example.com",
        "pairing",
        ["", "alice@example.com"],
      );
      expect(result.allowed).toBe(true);
    });

    it("supports multiple allowFrom entries", () => {
      const allowFrom = ["alice@example.com", "*@trusted.org", "bob@other.com"];
      expect(checkSenderAccess("alice@example.com", "pairing", allowFrom).allowed).toBe(true);
      expect(checkSenderAccess("anyone@trusted.org", "pairing", allowFrom).allowed).toBe(true);
      expect(checkSenderAccess("bob@other.com", "pairing", allowFrom).allowed).toBe(true);
      expect(checkSenderAccess("stranger@evil.com", "pairing", allowFrom).allowed).toBe(false);
    });
  });
});
