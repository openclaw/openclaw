import { describe, expect, it } from "vitest";
import {
  classifyFailoverReason,
  isAuthErrorMessage,
  isBillingErrorMessage,
  isCloudCodeAssistFormatError,
  isCloudflareOrHtmlErrorPage,
  isCompactionFailureError,
  isContextOverflowError,
  isFailoverErrorMessage,
  isImageDimensionErrorMessage,
  isLikelyContextOverflowError,
  isTimeoutErrorMessage,
  isTransientHttpError,
  parseImageDimensionError,
  parseImageSizeError,
} from "./pi-embedded-helpers.js";

describe("isAuthErrorMessage", () => {
  it("matches credential validation errors", () => {
    const samples = [
      'No credentials found for profile "anthropic:default".',
      "No API key found for profile openai.",
    ];
    for (const sample of samples) {
      expect(isAuthErrorMessage(sample)).toBe(true);
    }
  });
  it("matches OAuth refresh failures", () => {
    const samples = [
      "OAuth token refresh failed for anthropic: Failed to refresh OAuth token for anthropic. Please try again or re-authenticate.",
      "Please re-authenticate to continue.",
    ];
    for (const sample of samples) {
      expect(isAuthErrorMessage(sample)).toBe(true);
    }
  });
});

describe("isBillingErrorMessage", () => {
  it("matches credit / payment failures", () => {
    const samples = [
      "Your credit balance is too low to access the Anthropic API.",
      "insufficient credits",
      "Payment Required",
      "HTTP 402 Payment Required",
      "plans & billing",
    ];
    for (const sample of samples) {
      expect(isBillingErrorMessage(sample)).toBe(true);
    }
  });
  it("does not false-positive on issue IDs or text containing 402", () => {
    const falsePositives = [
      "Fixed issue CHE-402 in the latest release",
      "See ticket #402 for details",
      "ISSUE-402 has been resolved",
      "Room 402 is available",
      "Error code 403 was returned, not 402-related",
      "The building at 402 Main Street",
      "processed 402 records",
      "402 items found in the database",
      "port 402 is open",
      "Use a 402 stainless bolt",
      "Book a 402 room",
      "There is a 402 near me",
    ];
    for (const sample of falsePositives) {
      expect(isBillingErrorMessage(sample)).toBe(false);
    }
  });
  it("still matches real HTTP 402 billing errors", () => {
    const realErrors = [
      "HTTP 402 Payment Required",
      "status: 402",
      "error code 402",
      "http 402",
      "status=402 payment required",
      "got a 402 from the API",
      "returned 402",
      "received a 402 response",
      '{"status":402,"type":"error"}',
      '{"code":402,"message":"payment required"}',
      '{"error":{"code":402,"message":"billing hard limit reached"}}',
    ];
    for (const sample of realErrors) {
      expect(isBillingErrorMessage(sample)).toBe(true);
    }
  });
});

describe("isCloudCodeAssistFormatError", () => {
  it("matches format errors", () => {
    const samples = [
      "INVALID_REQUEST_ERROR: string should match pattern",
      "messages.1.content.1.tool_use.id",
      "tool_use.id should match pattern",
      "invalid request format",
    ];
    for (const sample of samples) {
      expect(isCloudCodeAssistFormatError(sample)).toBe(true);
    }
  });
});

describe("isCloudflareOrHtmlErrorPage", () => {
  it("detects Cloudflare 521 HTML pages", () => {
    const htmlError = `521 <!DOCTYPE html>
<html lang="en-US">
  <head><title>Web server is down | example.com | Cloudflare</title></head>
  <body><h1>Web server is down</h1></body>
</html>`;

    expect(isCloudflareOrHtmlErrorPage(htmlError)).toBe(true);
  });

  it("detects generic 5xx HTML pages", () => {
    const htmlError = `503 <html><head><title>Service Unavailable</title></head><body>down</body></html>`;
    expect(isCloudflareOrHtmlErrorPage(htmlError)).toBe(true);
  });

  it("does not flag non-HTML status lines", () => {
    expect(isCloudflareOrHtmlErrorPage("500 Internal Server Error")).toBe(false);
    expect(isCloudflareOrHtmlErrorPage("429 Too Many Requests")).toBe(false);
  });

  it("does not flag quoted HTML without a closing html tag", () => {
    const plainTextWithHtmlPrefix = "500 <!DOCTYPE html> upstream responded with partial HTML text";
    expect(isCloudflareOrHtmlErrorPage(plainTextWithHtmlPrefix)).toBe(false);
  });
});

describe("isCompactionFailureError", () => {
  it("matches compaction overflow failures", () => {
    const samples = [
      'Context overflow: Summarization failed: 400 {"message":"prompt is too long"}',
      "auto-compaction failed due to context overflow",
      "Compaction failed: prompt is too long",
      "Summarization failed: context window exceeded for this request",
    ];
    for (const sample of samples) {
      expect(isCompactionFailureError(sample)).toBe(true);
    }
  });
  it("ignores non-compaction overflow errors", () => {
    expect(isCompactionFailureError("Context overflow: prompt too large")).toBe(false);
    expect(isCompactionFailureError("rate limit exceeded")).toBe(false);
  });
});

describe("isContextOverflowError", () => {
  it("matches known overflow hints", () => {
    const samples = [
      "request_too_large",
      "Request exceeds the maximum size",
      "context length exceeded",
      "Maximum context length",
      "prompt is too long: 208423 tokens > 200000 maximum",
      "Context overflow: Summarization failed",
      "413 Request Entity Too Large",
    ];
    for (const sample of samples) {
      expect(isContextOverflowError(sample)).toBe(true);
    }
  });

  it("matches 'exceeds model context window' in various formats", () => {
    const samples = [
      // Anthropic returns this JSON payload when prompt exceeds model context window.
      '{"type":"error","error":{"type":"invalid_request_error","message":"Request size exceeds model context window"}}',
      "Request size exceeds model context window",
      "request size exceeds model context window",
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Request size exceeds model context window"}}',
      "The request size exceeds model context window limit",
    ];
    for (const sample of samples) {
      expect(isContextOverflowError(sample)).toBe(true);
    }
  });

  it("ignores normal conversation text mentioning context overflow", () => {
    // These are legitimate conversation snippets, not error messages
    expect(isContextOverflowError("Let's investigate the context overflow bug")).toBe(false);
    expect(isContextOverflowError("The mystery context overflow errors are strange")).toBe(false);
    expect(isContextOverflowError("We're debugging context overflow issues")).toBe(false);
    expect(isContextOverflowError("Something is causing context overflow messages")).toBe(false);
  });
});

describe("error classifiers", () => {
  it("ignore unrelated errors", () => {
    const checks: Array<{
      matcher: (message: string) => boolean;
      samples: string[];
    }> = [
      {
        matcher: isAuthErrorMessage,
        samples: ["rate limit exceeded", "billing issue detected"],
      },
      {
        matcher: isBillingErrorMessage,
        samples: ["rate limit exceeded", "invalid api key", "context length exceeded"],
      },
      {
        matcher: isCloudCodeAssistFormatError,
        samples: [
          "rate limit exceeded",
          '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.84.content.1.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels"}}',
        ],
      },
      {
        matcher: isContextOverflowError,
        samples: [
          "rate limit exceeded",
          "request size exceeds upload limit",
          "model not found",
          "authentication failed",
        ],
      },
    ];

    for (const check of checks) {
      for (const sample of check.samples) {
        expect(check.matcher(sample)).toBe(false);
      }
    }
  });
});

describe("isLikelyContextOverflowError", () => {
  it("matches context overflow hints", () => {
    const samples = [
      "Model context window is 128k tokens, you requested 256k tokens",
      "Context window exceeded: requested 12000 tokens",
      "Prompt too large for this model",
    ];
    for (const sample of samples) {
      expect(isLikelyContextOverflowError(sample)).toBe(true);
    }
  });

  it("excludes context window too small errors", () => {
    const samples = [
      "Model context window too small (minimum is 128k tokens)",
      "Context window too small: minimum is 1000 tokens",
    ];
    for (const sample of samples) {
      expect(isLikelyContextOverflowError(sample)).toBe(false);
    }
  });

  it("excludes rate limit errors that match the broad hint regex", () => {
    const samples = [
      "request reached organization TPD rate limit, current: 1506556, limit: 1500000",
      "rate limit exceeded",
      "too many requests",
      "429 Too Many Requests",
      "exceeded your current quota",
      "This request would exceed your account's rate limit",
      "429 Too Many Requests: request exceeds rate limit",
    ];
    for (const sample of samples) {
      expect(isLikelyContextOverflowError(sample)).toBe(false);
    }
  });
});

describe("isTransientHttpError", () => {
  it("returns true for retryable 5xx status codes", () => {
    expect(isTransientHttpError("500 Internal Server Error")).toBe(true);
    expect(isTransientHttpError("502 Bad Gateway")).toBe(true);
    expect(isTransientHttpError("503 Service Unavailable")).toBe(true);
    expect(isTransientHttpError("504 Gateway Timeout")).toBe(true);
    expect(isTransientHttpError("521 <!DOCTYPE html><html></html>")).toBe(true);
    expect(isTransientHttpError("529 Overloaded")).toBe(true);
  });

  it("returns false for non-retryable or non-http text", () => {
    expect(isTransientHttpError("429 Too Many Requests")).toBe(false);
    expect(isTransientHttpError("network timeout")).toBe(false);
  });
});

describe("isFailoverErrorMessage", () => {
  it("matches auth/rate/billing/timeout", () => {
    const samples = [
      "invalid api key",
      "429 rate limit exceeded",
      "Your credit balance is too low",
      "request timed out",
      "invalid request format",
    ];
    for (const sample of samples) {
      expect(isFailoverErrorMessage(sample)).toBe(true);
    }
  });

  it("matches abort stop-reason timeout variants", () => {
    const samples = ["Unhandled stop reason: abort", "stop reason: abort", "reason: abort"];
    for (const sample of samples) {
      expect(isTimeoutErrorMessage(sample)).toBe(true);
      expect(classifyFailoverReason(sample)).toBe("timeout");
      expect(isFailoverErrorMessage(sample)).toBe(true);
    }
  });
});

describe("parseImageSizeError", () => {
  it("parses max MB values from error text", () => {
    expect(parseImageSizeError("image exceeds 5 MB maximum")?.maxMb).toBe(5);
    expect(parseImageSizeError("Image exceeds 5.5 MB limit")?.maxMb).toBe(5.5);
  });

  it("returns null for unrelated errors", () => {
    expect(parseImageSizeError("context overflow")).toBeNull();
  });
});

describe("image dimension errors", () => {
  it("parses anthropic image dimension errors", () => {
    const raw =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.84.content.1.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels"}}';
    const parsed = parseImageDimensionError(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.maxDimensionPx).toBe(2000);
    expect(parsed?.messageIndex).toBe(84);
    expect(parsed?.contentIndex).toBe(1);
    expect(isImageDimensionErrorMessage(raw)).toBe(true);
  });
});

describe("classifyFailoverReason", () => {
  it("returns a stable reason", () => {
    expect(classifyFailoverReason("invalid api key")).toBe("auth");
    expect(classifyFailoverReason("no credentials found")).toBe("auth");
    expect(classifyFailoverReason("no api key found")).toBe("auth");
    expect(classifyFailoverReason("429 too many requests")).toBe("rate_limit");
    expect(classifyFailoverReason("resource has been exhausted")).toBe("rate_limit");
    expect(
      classifyFailoverReason(
        '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      ),
    ).toBe("rate_limit");
    expect(classifyFailoverReason("invalid request format")).toBe("format");
    expect(classifyFailoverReason("credit balance too low")).toBe("billing");
    expect(classifyFailoverReason("deadline exceeded")).toBe("timeout");
    expect(classifyFailoverReason("request ended without sending any chunks")).toBe("timeout");
    expect(
      classifyFailoverReason(
        "521 <!DOCTYPE html><html><head><title>Web server is down</title></head><body>Cloudflare</body></html>",
      ),
    ).toBe("timeout");
    expect(classifyFailoverReason("string should match pattern")).toBe("format");
    expect(classifyFailoverReason("bad request")).toBeNull();
    expect(
      classifyFailoverReason(
        "messages.84.content.1.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels",
      ),
    ).toBeNull();
    expect(classifyFailoverReason("image exceeds 5 MB maximum")).toBeNull();
  });
  it("classifies OpenAI usage limit errors as rate_limit", () => {
    expect(classifyFailoverReason("You have hit your ChatGPT usage limit (plus plan)")).toBe(
      "rate_limit",
    );
  });
  it("classifies provider high-demand / service-unavailable messages as rate_limit", () => {
    expect(
      classifyFailoverReason(
        "This model is currently experiencing high demand. Please try again later.",
      ),
    ).toBe("rate_limit");
    expect(classifyFailoverReason("LLM error: service unavailable")).toBe("rate_limit");
    expect(
      classifyFailoverReason(
        '{"error":{"code":503,"message":"The model is overloaded. Please try later","status":"UNAVAILABLE"}}',
      ),
    ).toBe("rate_limit");
  });
  it("classifies JSON api_error internal server failures as timeout", () => {
    expect(
      classifyFailoverReason(
        '{"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
      ),
    ).toBe("timeout");
  });
});
