import { describe, expect, it } from "vitest";
import { classifyCursorSdkError, type CursorSdkModule } from "./error-classification.js";

describe("classifyCursorSdkError", () => {
  function makeSdkModule(): CursorSdkModule {
    class AuthenticationError extends Error {}
    class RateLimitError extends Error {}
    return { AuthenticationError, RateLimitError };
  }

  it("classifies SDK AuthenticationError as auth", () => {
    const sdk = makeSdkModule();
    const err = new sdk.AuthenticationError("bad key");
    expect(classifyCursorSdkError(err, 100, 30000, sdk)).toBe("auth");
  });

  it("classifies SDK RateLimitError as rate_limit", () => {
    const sdk = makeSdkModule();
    const err = new sdk.RateLimitError("slow down");
    expect(classifyCursorSdkError(err, 100, 30000, sdk)).toBe("rate_limit");
  });

  it("classifies timeout by elapsed time", () => {
    expect(classifyCursorSdkError(new Error("unknown"), 30000, 30000)).toBe("timeout");
    expect(classifyCursorSdkError(new Error("unknown"), 31000, 30000)).toBe("timeout");
  });

  it("classifies timeout by message pattern", () => {
    expect(classifyCursorSdkError(new Error("Request Timeout"), 100, 30000)).toBe("timeout");
  });

  it("classifies rate limit by message pattern", () => {
    expect(classifyCursorSdkError(new Error("429 Too Many Requests"), 100, 30000)).toBe(
      "rate_limit",
    );
  });

  it("classifies auth by message pattern", () => {
    expect(classifyCursorSdkError(new Error("401 Unauthorized"), 100, 30000)).toBe("auth");
  });

  it("classifies billing by message pattern", () => {
    expect(classifyCursorSdkError(new Error("billing quota exceeded"), 100, 30000)).toBe("billing");
  });

  it("returns unclassified for unknown errors", () => {
    expect(classifyCursorSdkError(new Error("something broke"), 100, 30000)).toBe("unclassified");
  });

  it("handles non-Error values gracefully", () => {
    expect(classifyCursorSdkError("string error", 100, 30000)).toBe("unclassified");
    expect(classifyCursorSdkError(null, 100, 30000)).toBe("unclassified");
  });
});
