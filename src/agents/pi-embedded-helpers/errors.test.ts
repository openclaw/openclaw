import { describe, expect, it } from "vitest";
import {
  isContextOverflowError,
  isLikelyContextOverflowError,
  isCompactionFailureError,
  isRateLimitErrorMessage,
  isTimeoutErrorMessage,
  isBillingErrorMessage,
  isAuthErrorMessage,
  isOverloadedErrorMessage,
  parseImageDimensionError,
  parseImageSizeError,
  classifyFailoverReason,
  isFailoverErrorMessage,
  parseApiErrorInfo,
  isRawApiErrorPayload,
  getApiErrorPayloadFingerprint,
  isCloudflareOrHtmlErrorPage,
  isTransientHttpError,
} from "./errors.js";

describe("isContextOverflowError", () => {
  it("detects request_too_large", () => {
    expect(isContextOverflowError("request_too_large")).toBe(true);
  });

  it("detects context length exceeded", () => {
    expect(isContextOverflowError("context length exceeded")).toBe(true);
  });

  it("detects maximum context length", () => {
    expect(isContextOverflowError("maximum context length is 200000 tokens")).toBe(true);
  });

  it("detects prompt is too long", () => {
    expect(isContextOverflowError("prompt is too long")).toBe(true);
  });

  it("detects context overflow", () => {
    expect(isContextOverflowError("context overflow: something")).toBe(true);
  });

  it("detects 413 too large", () => {
    expect(isContextOverflowError("413 too large")).toBe(true);
  });

  it("returns false for empty input", () => {
    expect(isContextOverflowError("")).toBe(false);
    expect(isContextOverflowError(undefined)).toBe(false);
  });

  it("returns false for unrelated errors", () => {
    expect(isContextOverflowError("invalid api key")).toBe(false);
    expect(isContextOverflowError("rate limit exceeded")).toBe(false);
  });
});

describe("isLikelyContextOverflowError", () => {
  it("detects context overflow hints", () => {
    expect(isLikelyContextOverflowError("context window too large")).toBe(true);
    expect(isLikelyContextOverflowError("input exceeds context limit")).toBe(true);
  });

  it("excludes rate limit errors that match broad pattern", () => {
    expect(isLikelyContextOverflowError("request reached organization rate limit")).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(isLikelyContextOverflowError("")).toBe(false);
  });
});

describe("isCompactionFailureError", () => {
  it("detects summarization failed with context overflow", () => {
    expect(isCompactionFailureError("summarization failed: context overflow")).toBe(true);
  });

  it("detects auto-compaction with context", () => {
    expect(isCompactionFailureError("auto-compaction: context overflow")).toBe(true);
  });

  it("detects context overflow with compaction term", () => {
    expect(isCompactionFailureError("compaction context overflow")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isCompactionFailureError("invalid api key")).toBe(false);
  });

  it("returns false for compaction term without overflow", () => {
    expect(isCompactionFailureError("compaction completed")).toBe(false);
  });
});

describe("isRateLimitErrorMessage", () => {
  it("detects rate limit patterns", () => {
    expect(isRateLimitErrorMessage("rate limit exceeded")).toBe(true);
    expect(isRateLimitErrorMessage("too many requests")).toBe(true);
    expect(isRateLimitErrorMessage("429 Too Many Requests")).toBe(true);
  });

  it("detects quota patterns", () => {
    expect(isRateLimitErrorMessage("exceeded your current quota")).toBe(true);
    expect(isRateLimitErrorMessage("quota exceeded")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isRateLimitErrorMessage("invalid api key")).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(isRateLimitErrorMessage("")).toBe(false);
  });
});

describe("isTimeoutErrorMessage", () => {
  it("detects timeout patterns", () => {
    expect(isTimeoutErrorMessage("request timed out")).toBe(true);
    expect(isTimeoutErrorMessage("deadline exceeded")).toBe(true);
    expect(isTimeoutErrorMessage("context deadline exceeded")).toBe(true);
  });

  it("detects abort patterns", () => {
    expect(isTimeoutErrorMessage("stop reason: abort")).toBe(true);
    expect(isTimeoutErrorMessage("unhandled stop reason: abort")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isTimeoutErrorMessage("invalid api key")).toBe(false);
  });
});

describe("isBillingErrorMessage", () => {
  it("detects billing error patterns", () => {
    expect(isBillingErrorMessage("payment required")).toBe(true);
    expect(isBillingErrorMessage("insufficient credits")).toBe(true);
    expect(isBillingErrorMessage("credit balance low")).toBe(true);
  });

  it("detects HTTP 402", () => {
    expect(isBillingErrorMessage("402 payment required")).toBe(true);
    expect(isBillingErrorMessage('{"code": 402}')).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isBillingErrorMessage("rate limit exceeded")).toBe(false);
  });
});

describe("isAuthErrorMessage", () => {
  it("detects auth error patterns", () => {
    expect(isAuthErrorMessage("invalid api key")).toBe(true);
    expect(isAuthErrorMessage("incorrect api key")).toBe(true);
    expect(isAuthErrorMessage("authentication failed")).toBe(true);
    expect(isAuthErrorMessage("unauthorized")).toBe(true);
  });

  it("detects HTTP 401 and 403", () => {
    expect(isAuthErrorMessage("401 unauthorized")).toBe(true);
    expect(isAuthErrorMessage("403 forbidden")).toBe(true);
  });

  it("detects expired token", () => {
    expect(isAuthErrorMessage("token has expired")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isAuthErrorMessage("rate limit exceeded")).toBe(false);
  });
});

describe("isOverloadedErrorMessage", () => {
  it("detects overloaded patterns", () => {
    expect(isOverloadedErrorMessage("overloaded_error")).toBe(true);
    expect(isOverloadedErrorMessage("service is overloaded")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isOverloadedErrorMessage("invalid api key")).toBe(false);
  });
});

describe("parseImageDimensionError", () => {
  it("parses dimension error with pixel limit", () => {
    const result = parseImageDimensionError(
      "image dimensions exceed max allowed size for many-image requests: 4096 pixels",
    );
    expect(result?.maxDimensionPx).toBe(4096);
    expect(result?.raw).toContain("image dimensions");
  });

  it("parses dimension error with path", () => {
    const result = parseImageDimensionError(
      "image dimensions exceed max allowed size for many-image requests: 4096 pixels (messages.1.content.2.image)",
    );
    expect(result?.maxDimensionPx).toBe(4096);
    expect(result?.messageIndex).toBe(1);
    expect(result?.contentIndex).toBe(2);
  });

  it("returns null for non-dimension errors", () => {
    expect(parseImageDimensionError("invalid api key")).toBe(null);
  });
});

describe("parseImageSizeError", () => {
  it("parses size error with MB limit", () => {
    const result = parseImageSizeError("image exceeds 10.5 mb");
    expect(result?.maxMb).toBe(10.5);
    expect(result?.raw).toContain("image exceeds");
  });

  it("returns null for non-size errors", () => {
    expect(parseImageSizeError("invalid api key")).toBe(null);
  });
});

describe("classifyFailoverReason", () => {
  it("classifies rate limit as rate_limit", () => {
    expect(classifyFailoverReason("rate limit exceeded")).toBe("rate_limit");
  });

  it("classifies overloaded as rate_limit", () => {
    expect(classifyFailoverReason("service is overloaded")).toBe("rate_limit");
  });

  it("classifies timeout as timeout", () => {
    expect(classifyFailoverReason("request timed out")).toBe("timeout");
  });

  it("classifies billing as billing", () => {
    expect(classifyFailoverReason("payment required")).toBe("billing");
  });

  it("classifies auth as auth", () => {
    expect(classifyFailoverReason("invalid api key")).toBe("auth");
  });

  it("returns null for non-failover errors", () => {
    expect(classifyFailoverReason("hello world")).toBe(null);
  });

  it("returns null for image dimension errors (handled specially)", () => {
    expect(
      classifyFailoverReason("image dimensions exceed max allowed size for many-image requests"),
    ).toBe(null);
  });

  it("returns null for image size errors (handled specially)", () => {
    expect(classifyFailoverReason("image exceeds 10 mb")).toBe(null);
  });

  it("treats transient 5xx as timeout", () => {
    expect(classifyFailoverReason("500 internal server error")).toBe("timeout");
    expect(classifyFailoverReason("502 bad gateway")).toBe("timeout");
    expect(classifyFailoverReason("503 service unavailable")).toBe("timeout");
  });
});

describe("isFailoverErrorMessage", () => {
  it("returns true for failover errors", () => {
    expect(isFailoverErrorMessage("rate limit exceeded")).toBe(true);
    expect(isFailoverErrorMessage("request timed out")).toBe(true);
  });

  it("returns false for non-failover errors", () => {
    expect(isFailoverErrorMessage("hello world")).toBe(false);
  });
});

describe("parseApiErrorInfo", () => {
  it("parses JSON error payload", () => {
    const result = parseApiErrorInfo(
      '{"error": {"message": "invalid request", "type": "invalid_request_error"}}',
    );
    expect(result?.message).toBe("invalid request");
    expect(result?.type).toBe("invalid_request_error");
  });

  it("extracts request_id from payload", () => {
    const result = parseApiErrorInfo('{"request_id": "abc123", "error": {"message": "fail"}}');
    expect(result?.requestId).toBe("abc123");
  });

  it("extracts requestId (camelCase) from payload", () => {
    const result = parseApiErrorInfo('{"requestId": "xyz789", "error": {"message": "fail"}}');
    expect(result?.requestId).toBe("xyz789");
  });

  it("returns null for non-JSON input", () => {
    expect(parseApiErrorInfo("just some text")).toBe(null);
  });
});

describe("isRawApiErrorPayload", () => {
  it("detects JSON error payloads", () => {
    expect(isRawApiErrorPayload('{"error": {"message": "fail"}}')).toBe(true);
  });

  it("returns false for plain text", () => {
    expect(isRawApiErrorPayload("rate limit exceeded")).toBe(false);
  });
});

describe("getApiErrorPayloadFingerprint", () => {
  it("generates stable fingerprint for error payload", () => {
    const fp1 = getApiErrorPayloadFingerprint('{"error": {"message": "fail"}}');
    const fp2 = getApiErrorPayloadFingerprint('{"error": {"message": "fail"}}');
    expect(fp1).toBe(fp2);
  });

  it("returns null for non-payload input", () => {
    expect(getApiErrorPayloadFingerprint("hello")).toBe(null);
  });
});

describe("isCloudflareOrHtmlErrorPage", () => {
  it("detects Cloudflare error codes", () => {
    expect(isCloudflareOrHtmlErrorPage("521 Origin Down <html>")).toBe(true);
    expect(isCloudflareOrHtmlErrorPage("522 Connection timed out <html>")).toBe(true);
  });

  it("detects 5xx with HTML", () => {
    expect(isCloudflareOrHtmlErrorPage("500 <html><body>Error</body></html>")).toBe(true);
  });

  it("returns false for non-5xx", () => {
    expect(isCloudflareOrHtmlErrorPage("404 Not Found")).toBe(false);
  });

  it("returns false for 5xx without HTML", () => {
    expect(isCloudflareOrHtmlErrorPage("500 Internal Server Error")).toBe(false);
  });
});

describe("isTransientHttpError", () => {
  it("detects transient error codes", () => {
    expect(isTransientHttpError("500 internal server error")).toBe(true);
    expect(isTransientHttpError("502 bad gateway")).toBe(true);
    expect(isTransientHttpError("503 service unavailable")).toBe(true);
  });

  it("detects Cloudflare transient codes", () => {
    expect(isTransientHttpError("521 origin down")).toBe(true);
    expect(isTransientHttpError("522 connection timed out")).toBe(true);
  });

  it("returns false for non-transient codes", () => {
    expect(isTransientHttpError("400 bad request")).toBe(false);
    expect(isTransientHttpError("404 not found")).toBe(false);
  });
});
