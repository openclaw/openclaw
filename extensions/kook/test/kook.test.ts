// KOOK Plugin Test Suite
import { describe, it, expect } from "vitest";
import { normalizeAccountId, DEFAULT_ACCOUNT_ID } from "../../../src/kook/token.js";
import { normalizeKookToken } from "../../../src/kook/token.js";

describe("KOOK Token Utils", () => {
  describe("normalizeAccountId", () => {
    it("should return default for empty string", () => {
      expect(normalizeAccountId("")).toBe(DEFAULT_ACCOUNT_ID);
    });

    it("should return default for null", () => {
      expect(normalizeAccountId(null)).toBe(DEFAULT_ACCOUNT_ID);
    });

    it("should return default for undefined", () => {
      expect(normalizeAccountId(undefined)).toBe(DEFAULT_ACCOUNT_ID);
    });

    it("should trim whitespace", () => {
      expect(normalizeAccountId("  account1  ")).toBe("account1");
    });
  });

  describe("normalizeKookToken", () => {
    it("should return undefined for empty string", () => {
      expect(normalizeKookToken("")).toBeUndefined();
    });

    it("should return undefined for null", () => {
      expect(normalizeKookToken(null)).toBeUndefined();
    });

    it("should return undefined for undefined", () => {
      expect(normalizeKookToken(undefined)).toBeUndefined();
    });

    it("should trim whitespace", () => {
      expect(normalizeKookToken("  token123  ")).toBe("token123");
    });
  });
});

// TODO: Add more comprehensive tests for:
// - Config schema validation
// - Message handling
// - WebSocket gateway connection
// - Security policy enforcement
