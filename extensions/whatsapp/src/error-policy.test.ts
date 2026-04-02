import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildWhatsAppErrorScopeKey,
  isSilentErrorPolicy,
  resolveWhatsAppErrorPolicy,
  resetWhatsAppErrorPolicyStoreForTest,
  shouldSuppressWhatsAppError,
} from "./error-policy.js";

describe("whatsapp error policy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    resetWhatsAppErrorPolicyStoreForTest();
  });

  afterEach(() => {
    resetWhatsAppErrorPolicyStoreForTest();
    vi.useRealTimers();
  });

  describe("resolveWhatsAppErrorPolicy", () => {
    it("defaults to always with standard cooldown when no config provided", () => {
      expect(resolveWhatsAppErrorPolicy({})).toEqual({
        policy: "always",
        cooldownMs: 14400000,
      });
    });

    it("resolves policy and cooldown from account config", () => {
      expect(
        resolveWhatsAppErrorPolicy({
          accountConfig: { errorPolicy: "once", errorCooldownMs: 5000 },
        }),
      ).toEqual({
        policy: "once",
        cooldownMs: 5000,
      });
    });

    it("resolves silent policy", () => {
      expect(
        resolveWhatsAppErrorPolicy({
          accountConfig: { errorPolicy: "silent" },
        }),
      ).toEqual({
        policy: "silent",
        cooldownMs: 14400000,
      });
    });
  });

  describe("isSilentErrorPolicy", () => {
    it("returns true for silent", () => {
      expect(isSilentErrorPolicy("silent")).toBe(true);
    });

    it("returns false for always", () => {
      expect(isSilentErrorPolicy("always")).toBe(false);
    });

    it("returns false for once", () => {
      expect(isSilentErrorPolicy("once")).toBe(false);
    });
  });

  describe("buildWhatsAppErrorScopeKey", () => {
    it("combines account and chat ids", () => {
      expect(
        buildWhatsAppErrorScopeKey({ accountId: "default", chatId: "+14801234567" }),
      ).toBe("default\x00+14801234567");
    });
  });

  describe("shouldSuppressWhatsAppError", () => {
    it("does not suppress the first occurrence of an error", () => {
      const scopeKey = buildWhatsAppErrorScopeKey({
        accountId: "default",
        chatId: "+14801234567",
      });

      expect(
        shouldSuppressWhatsAppError({
          scopeKey,
          cooldownMs: 1000,
          errorMessage: "429",
        }),
      ).toBe(false);
    });

    it("suppresses repeated matching errors within cooldown", () => {
      const scopeKey = buildWhatsAppErrorScopeKey({
        accountId: "default",
        chatId: "+14801234567",
      });

      expect(
        shouldSuppressWhatsAppError({
          scopeKey,
          cooldownMs: 1000,
          errorMessage: "429",
        }),
      ).toBe(false);
      expect(
        shouldSuppressWhatsAppError({
          scopeKey,
          cooldownMs: 1000,
          errorMessage: "429",
        }),
      ).toBe(true);
    });

    it("does not suppress different error messages", () => {
      const scopeKey = buildWhatsAppErrorScopeKey({
        accountId: "default",
        chatId: "+14801234567",
      });

      expect(
        shouldSuppressWhatsAppError({
          scopeKey,
          cooldownMs: 1000,
          errorMessage: "429",
        }),
      ).toBe(false);
      expect(
        shouldSuppressWhatsAppError({
          scopeKey,
          cooldownMs: 1000,
          errorMessage: "500",
        }),
      ).toBe(false);
    });

    it("allows errors again after cooldown expires", () => {
      const scopeKey = buildWhatsAppErrorScopeKey({
        accountId: "default",
        chatId: "+14801234567",
      });

      expect(
        shouldSuppressWhatsAppError({
          scopeKey,
          cooldownMs: 1000,
          errorMessage: "429",
        }),
      ).toBe(false);
      vi.advanceTimersByTime(1001);
      expect(
        shouldSuppressWhatsAppError({
          scopeKey,
          cooldownMs: 1000,
          errorMessage: "429",
        }),
      ).toBe(false);
    });

    it("does not leak suppression across accounts", () => {
      const scope1 = buildWhatsAppErrorScopeKey({
        accountId: "work",
        chatId: "+14801234567",
      });
      const scope2 = buildWhatsAppErrorScopeKey({
        accountId: "personal",
        chatId: "+14801234567",
      });

      expect(
        shouldSuppressWhatsAppError({
          scopeKey: scope1,
          cooldownMs: 1000,
          errorMessage: "429",
        }),
      ).toBe(false);
      expect(
        shouldSuppressWhatsAppError({
          scopeKey: scope2,
          cooldownMs: 1000,
          errorMessage: "429",
        }),
      ).toBe(false);
    });

    it("does not leak suppression across chats", () => {
      const scope1 = buildWhatsAppErrorScopeKey({
        accountId: "default",
        chatId: "+14801234567",
      });
      const scope2 = buildWhatsAppErrorScopeKey({
        accountId: "default",
        chatId: "+14809876543",
      });

      expect(
        shouldSuppressWhatsAppError({
          scopeKey: scope1,
          cooldownMs: 1000,
          errorMessage: "429",
        }),
      ).toBe(false);
      expect(
        shouldSuppressWhatsAppError({
          scopeKey: scope2,
          cooldownMs: 1000,
          errorMessage: "429",
        }),
      ).toBe(false);
    });
  });
});
