import { describe, it, expect } from "vitest";
import {
  validateUUID,
  validateISODate,
  validateCurrency,
  validatePositiveAmount,
  validateRequired,
} from "./validators.js";

describe("ERP validators", () => {
  describe("validateUUID", () => {
    it("accepts valid UUID v4", () => {
      expect(validateUUID("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    });
    it("rejects invalid string", () => {
      expect(validateUUID("not-a-uuid")).toBe(false);
    });
    it("rejects empty string", () => {
      expect(validateUUID("")).toBe(false);
    });
  });

  describe("validateISODate", () => {
    it("accepts YYYY-MM-DD", () => {
      expect(validateISODate("2026-03-15")).toBe(true);
    });
    it("rejects invalid date", () => {
      expect(validateISODate("2026-13-45")).toBe(false);
    });
    it("rejects empty string", () => {
      expect(validateISODate("")).toBe(false);
    });
  });

  describe("validateCurrency", () => {
    it("accepts 3-letter uppercase code", () => {
      expect(validateCurrency("USD")).toBe(true);
      expect(validateCurrency("EUR")).toBe(true);
    });
    it("rejects lowercase", () => {
      expect(validateCurrency("usd")).toBe(false);
    });
    it("rejects wrong length", () => {
      expect(validateCurrency("US")).toBe(false);
    });
  });

  describe("validatePositiveAmount", () => {
    it("accepts positive number", () => {
      expect(validatePositiveAmount(100.5)).toBe(true);
    });
    it("rejects zero", () => {
      expect(validatePositiveAmount(0)).toBe(false);
    });
    it("rejects negative", () => {
      expect(validatePositiveAmount(-10)).toBe(false);
    });
    it("rejects NaN", () => {
      expect(validatePositiveAmount(NaN)).toBe(false);
    });
  });

  describe("validateRequired", () => {
    it("returns null when all fields present", () => {
      expect(validateRequired({ name: "Alice", age: 30 }, ["name", "age"])).toBeNull();
    });
    it("returns error for missing field", () => {
      expect(validateRequired({ name: "Alice" }, ["name", "email"])).toBe(
        "Missing required field: email",
      );
    });
  });
});
