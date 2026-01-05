import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";

import { isRateLimitAssistantError } from "./pi-embedded-helpers.js";

const asAssistant = (overrides: Partial<AssistantMessage>) =>
  ({ role: "assistant", stopReason: "error", ...overrides }) as AssistantMessage;

describe("isRateLimitAssistantError", () => {
  it("detects 429 rate limit payloads", () => {
    const msg = asAssistant({
      errorMessage:
        '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    });
    expect(isRateLimitAssistantError(msg)).toBe(true);
  });

  it("detects human-readable rate limit messages", () => {
    const msg = asAssistant({
      errorMessage: "Too many requests. Rate limit exceeded.",
    });
    expect(isRateLimitAssistantError(msg)).toBe(true);
  });

  it("returns false for non-error messages", () => {
    const msg = asAssistant({
      stopReason: "end_turn",
      errorMessage: "rate limit",
    });
    expect(isRateLimitAssistantError(msg)).toBe(false);
  });
});
