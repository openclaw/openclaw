import { describe, expect, it } from "vitest";
import {
  isContextOverflowError,
  isRateLimitErrorMessage,
  isOverloadedErrorMessage,
  formatBillingErrorMessage,
} from "./errors.js";

describe("isContextOverflowError", () => {
  it("returns true for context window exceeded messages", () => {
    expect(isContextOverflowError("context window exceeded")).toBe(true);
    expect(isContextOverflowError("maximum context length reached")).toBe(true);
    expect(isContextOverflowError("prompt is too long")).toBe(true);
  });

  it("returns true for request too large messages", () => {
    expect(isContextOverflowError("request_too_large")).toBe(true);
    expect(isContextOverflowError("request exceeds the maximum size")).toBe(true);
    expect(isContextOverflowError("413 too large")).toBe(true);
  });

  it("returns true for Chinese error messages", () => {
    expect(isContextOverflowError("上下文过长")).toBe(true);
    expect(isContextOverflowError("上下文超出限制")).toBe(true);
    expect(isContextOverflowError("超出最大上下文长度")).toBe(true);
    expect(isContextOverflowError("请压缩上下文")).toBe(true);
  });

  it("returns false for rate limit errors", () => {
    expect(isContextOverflowError("rate limit exceeded")).toBe(false);
    expect(isContextOverflowError("too many requests")).toBe(false);
    expect(isContextOverflowError("tpm limit reached")).toBe(false);
  });

  it("returns false for empty or undefined input", () => {
    expect(isContextOverflowError("")).toBe(false);
    expect(isContextOverflowError(undefined)).toBe(false);
  });

  it("returns false for unrelated errors", () => {
    expect(isContextOverflowError("authentication failed")).toBe(false);
    expect(isContextOverflowError("network timeout")).toBe(false);
  });
});

describe("isRateLimitErrorMessage", () => {
  it("returns true for rate limit messages", () => {
    expect(isRateLimitErrorMessage("rate limit exceeded")).toBe(true);
    expect(isRateLimitErrorMessage("too many requests")).toBe(true);
    expect(isRateLimitErrorMessage("429 error")).toBe(true);
  });

  it("returns false for non-rate-limit messages", () => {
    expect(isRateLimitErrorMessage("context window exceeded")).toBe(false);
    expect(isRateLimitErrorMessage("authentication failed")).toBe(false);
  });
});

describe("isOverloadedErrorMessage", () => {
  it("returns true for overloaded messages", () => {
    expect(isOverloadedErrorMessage("service overloaded")).toBe(true);
    expect(isOverloadedErrorMessage("server is busy")).toBe(true);
  });

  it("returns false for non-overloaded messages", () => {
    expect(isOverloadedErrorMessage("rate limit exceeded")).toBe(false);
    expect(isOverloadedErrorMessage("context window exceeded")).toBe(false);
  });
});

describe("formatBillingErrorMessage", () => {
  it("formats message with provider and model", () => {
    const msg = formatBillingErrorMessage("openai", "gpt-4");
    expect(msg).toContain("openai (gpt-4)");
    expect(msg).toContain("billing error");
  });

  it("formats message with provider only", () => {
    const msg = formatBillingErrorMessage("anthropic");
    expect(msg).toContain("anthropic");
    expect(msg).toContain("billing error");
  });

  it("formats generic message without provider", () => {
    const msg = formatBillingErrorMessage();
    expect(msg).toContain("API provider");
    expect(msg).toContain("billing error");
  });
});
