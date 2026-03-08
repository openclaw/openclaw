import { describe, expect, it } from "vitest";
import { sanitizeUserFacingText } from "./pi-embedded-helpers.js";

describe("sanitizeUserFacingText with errorKind", () => {
  it("returns billing message when errorKind is billing", () => {
    const result = sanitizeUserFacingText("some unrelated text", {
      errorContext: true,
      errorKind: "billing",
    });
    expect(result).toContain("billing error");
  });

  it("returns rate limit message when errorKind is rate_limit", () => {
    const result = sanitizeUserFacingText("some unrelated text", {
      errorContext: true,
      errorKind: "rate_limit",
    });
    expect(result).toContain("rate limit");
  });

  it("returns overloaded message when errorKind is overloaded", () => {
    const result = sanitizeUserFacingText("some unrelated text", {
      errorContext: true,
      errorKind: "overloaded",
    });
    expect(result).toContain("overloaded");
  });

  it("returns timeout message when errorKind is timeout", () => {
    const result = sanitizeUserFacingText("some unrelated text", {
      errorContext: true,
      errorKind: "timeout",
    });
    expect(result).toBe("LLM request timed out.");
  });

  it("returns context overflow message when errorKind is context_overflow", () => {
    const result = sanitizeUserFacingText("some unrelated text", {
      errorContext: true,
      errorKind: "context_overflow",
    });
    expect(result).toContain("Context overflow");
  });

  it("returns context overflow message when errorKind is compaction_failure", () => {
    const result = sanitizeUserFacingText("some unrelated text", {
      errorContext: true,
      errorKind: "compaction_failure",
    });
    expect(result).toContain("Context overflow");
  });

  it("returns role ordering message when errorKind is role_ordering", () => {
    const result = sanitizeUserFacingText("some unrelated text", {
      errorContext: true,
      errorKind: "role_ordering",
    });
    expect(result).toContain("Message ordering conflict");
  });

  it("does not reclassify via regex for errorKind unknown", () => {
    // Text contains billing keywords but errorKind says unknown — should NOT
    // reclassify as billing. Formats as raw HTTP error instead.
    const result = sanitizeUserFacingText("Error: 402 payment required", {
      errorContext: true,
      errorKind: "unknown",
    });
    expect(result).not.toContain("billing error");
  });

  it("does not reclassify via regex when errorKind is undefined", () => {
    // Same: no regex reclassification without structured errorKind.
    const result = sanitizeUserFacingText("Error: 402 payment required", {
      errorContext: true,
    });
    expect(result).not.toContain("billing error");
  });

  it("prevents false positive: timeout errorKind with billing keywords returns timeout, not billing", () => {
    // This is the core bug fix: a tool returning HTTP 402 should NOT be
    // misclassified as an LLM billing error when errorKind says "timeout".
    const result = sanitizeUserFacingText(
      "Error: 402 payment required - upstream service billing issue",
      { errorContext: true, errorKind: "timeout" },
    );
    expect(result).toBe("LLM request timed out.");
    expect(result).not.toContain("billing");
  });

  it("does not use errorKind when errorContext is false", () => {
    // errorKind only applies within the errorContext block
    const text = "Hello world";
    const result = sanitizeUserFacingText(text, {
      errorContext: false,
      errorKind: "billing",
    });
    expect(result).toBe("Hello world");
  });
});
