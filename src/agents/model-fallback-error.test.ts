import { describe, it, expect } from "vitest";
import { AllModelsFailedError, isAllModelsFailedError } from "./model-fallback-error.js";

describe("AllModelsFailedError", () => {
  it("creates error with cooldown-only flag", () => {
    const error = new AllModelsFailedError("All models failed", {
      attempts: [
        {
          provider: "anthropic",
          model: "claude-3-5",
          error: "cooldown",
          reason: "rate_limit",
        },
      ],
      allInCooldown: true,
      retryAfterMs: 300000,
    });

    expect(error.name).toBe("AllModelsFailedError");
    expect(error.allInCooldown).toBe(true);
    expect(error.isCooldownOnly()).toBe(true);
    expect(isAllModelsFailedError(error)).toBe(true);
    expect(error.retryAfterMs).toBe(300000);
  });

  it("distinguishes mixed failures", () => {
    const error = new AllModelsFailedError("msg", {
      attempts: [
        { provider: "anthropic", model: "c", error: "cooldown", reason: "rate_limit" },
        { provider: "openai", model: "gpt-4", error: "auth", reason: "auth" },
      ],
      allInCooldown: false,
    });
    expect(error.isCooldownOnly()).toBe(false);
    expect(error.allInCooldown).toBe(false);
  });

  it("returns false for isCooldownOnly when no attempts", () => {
    const error = new AllModelsFailedError("msg", {
      attempts: [],
      allInCooldown: true,
    });
    expect(error.isCooldownOnly()).toBe(false);
  });

  it("preserves cause in error chain", () => {
    const cause = new Error("Original error");
    const error = new AllModelsFailedError("All models failed", {
      attempts: [{ provider: "anthropic", model: "c", error: "cooldown", reason: "rate_limit" }],
      allInCooldown: true,
      cause,
    });

    expect(error.cause).toBe(cause);
  });

  it("includes all attempt details", () => {
    const attempts = [
      {
        provider: "anthropic",
        model: "c",
        error: "cooldown",
        reason: "rate_limit" as const,
        status: 429,
        code: "rate_limit",
      },
      { provider: "openai", model: "gpt-4", error: "auth", reason: "auth" as const, status: 401 },
    ];
    const error = new AllModelsFailedError("msg", {
      attempts,
      allInCooldown: false,
    });

    expect(error.attempts).toEqual(attempts);
  });

  it("type guard works correctly", () => {
    const error = new AllModelsFailedError("msg", {
      attempts: [{ provider: "anthropic", model: "c", error: "c", reason: "rate_limit" }],
      allInCooldown: true,
    });
    expect(isAllModelsFailedError(error)).toBe(true);

    const regularError = new Error("regular");
    expect(isAllModelsFailedError(regularError)).toBe(false);

    expect(isAllModelsFailedError(null)).toBe(false);
    expect(isAllModelsFailedError(undefined)).toBe(false);
    expect(isAllModelsFailedError("string")).toBe(false);
  });
});
