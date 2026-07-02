// Covers provider-specific failover matcher regressions.
import { describe, expect, it } from "vitest";
import { classifyFailoverReason } from "./errors.js";
import {
  isAuthErrorMessage,
  isBillingErrorMessage,
  isOverloadedErrorMessage,
  isRateLimitErrorMessage,
  isServerErrorMessage,
  isTimeoutErrorMessage,
} from "./failover-matches.js";

describe("Z.ai vendor error codes (#48988)", () => {
  describe("error 1311 — model not included in subscription plan", () => {
    it("classifies Z.ai 1311 JSON body as billing", () => {
      // Z.ai 1311 is a plan entitlement failure, not rate limiting.
      const raw =
        '{"code":1311,"message":"The model you requested is not available in your current plan"}';
      expect(isBillingErrorMessage(raw)).toBe(true);
    });

    it("classifies prose-only subscription plan access denials as billing", () => {
      const raw =
        "FailoverError: Your current subscription plan does not yet include access to GLM-5V-Turbo";
      expect(isBillingErrorMessage(raw)).toBe(true);
    });

    it("classifies Z.ai 1311 with spaces as billing", () => {
      const raw = '{"code": 1311, "message": "model not on plan"}';
      expect(isBillingErrorMessage(raw)).toBe(true);
    });

    it("does not misclassify 1311 as rate_limit", () => {
      const raw =
        '{"code":1311,"message":"The model you requested is not available in your current plan"}';
      expect(isRateLimitErrorMessage(raw)).toBe(false);
    });

    it("does not misclassify 1311 as auth", () => {
      const raw =
        '{"code":1311,"message":"The model you requested is not available in your current plan"}';
      expect(isAuthErrorMessage(raw)).toBe(false);
    });

    it("classifies long Z.ai 1311 payloads as billing", () => {
      const raw = JSON.stringify({
        code: 1311,
        message: "The model you requested is not available in your current plan",
        details: "x".repeat(700),
      });
      expect(raw.length).toBeGreaterThan(512);
      expect(isBillingErrorMessage(raw)).toBe(true);
    });
  });

  describe("error 1113 — wrong endpoint or invalid credentials", () => {
    it("classifies Z.ai 1113 JSON body as auth", () => {
      const raw = '{"code":1113,"message":"invalid api endpoint or credentials"}';
      expect(isAuthErrorMessage(raw)).toBe(true);
    });

    it("classifies Z.ai 1113 with spaces as auth", () => {
      const raw = '{"code": 1113, "message": "invalid api endpoint or credentials"}';
      expect(isAuthErrorMessage(raw)).toBe(true);
    });

    it("does not misclassify 1113 as rate_limit", () => {
      const raw = '{"code":1113,"message":"invalid api endpoint or credentials"}';
      expect(isRateLimitErrorMessage(raw)).toBe(false);
    });

    it("does not misclassify 1113 as billing", () => {
      const raw = '{"code":1113,"message":"invalid api endpoint or credentials"}';
      expect(isBillingErrorMessage(raw)).toBe(false);
    });
  });

  describe("existing patterns are unaffected", () => {
    it("rate limit still classified correctly", () => {
      expect(isRateLimitErrorMessage("rate limit exceeded")).toBe(true);
    });

    it("OpenAI model-capacity text is classified as overloaded", () => {
      expect(
        isOverloadedErrorMessage("Selected model is at capacity. Please try a different model."),
      ).toBe(true);
    });

    it("OpenRouter high-load text is classified as overloaded", () => {
      expect(
        isOverloadedErrorMessage(
          "The service is currently experiencing high load and cannot process your request.",
        ),
      ).toBe(true);
    });

    it("billing still classified correctly", () => {
      expect(isBillingErrorMessage("insufficient credits")).toBe(true);
    });

    it("auth still classified correctly", () => {
      expect(isAuthErrorMessage("invalid api key provided")).toBe(true);
    });
  });
});

describe("Chinese provider overload messages", () => {
  const ZHIPU_OVERLOAD = "[1305][该模型当前访问量过大，请您稍后再试]";

  it("classifies the Zhipu GLM overload body as overloaded", () => {
    expect(isOverloadedErrorMessage(ZHIPU_OVERLOAD)).toBe(true);
  });

  it("does not misclassify the GLM overload body as rate limit or auth", () => {
    expect(isRateLimitErrorMessage(ZHIPU_OVERLOAD)).toBe(false);
    expect(isAuthErrorMessage(ZHIPU_OVERLOAD)).toBe(false);
  });
});

describe("Volcengine Coding Plan subscription errors", () => {
  it("classifies InvalidSubscription JSON body as billing", () => {
    const raw =
      '{"error":{"code":"InvalidSubscription","message":"Your account does not have a valid CodingPlan subscription, or your subscription has expired."}}';
    expect(isBillingErrorMessage(raw)).toBe(true);
  });

  it("classifies long InvalidSubscription payloads as billing", () => {
    const raw = JSON.stringify({
      error: {
        code: "InvalidSubscription",
        message:
          "Your account does not have a valid coding plan subscription, or your subscription has expired.",
        details: "x".repeat(700),
      },
    });
    expect(raw.length).toBeGreaterThan(512);
    expect(isBillingErrorMessage(raw)).toBe(true);
  });

  it("classifies InvalidSubscription as billing before auth or rate limit", () => {
    const raw =
      '{"error":{"code":"InvalidSubscription","message":"Your account does not have a valid CodingPlan subscription, or your subscription has expired."}}';
    expect(isRateLimitErrorMessage(raw)).toBe(false);
    expect(classifyFailoverReason(raw)).toBe("billing");
  });
});

describe("agent harness provider mismatch (#91710)", () => {
  it("classifies harness provider rejection as format error", () => {
    expect(
      classifyFailoverReason(
        'Requested agent harness "codex" does not support openai/gpt-5.3-codex (provider is not one of: codex).',
      ),
    ).toBe("format");
  });

  it("classifies harness provider rejection with multiple providers as format error", () => {
    expect(
      classifyFailoverReason(
        'Requested agent harness "codex" does not support openrouter/gpt-5.4 (provider is not one of: codex, openai).',
      ),
    ).toBe("format");
  });
});

describe("server error status classification", () => {
  it("classifies a bare internal server error status as server error", () => {
    // Bare status lines from providers should classify, while prefixed prose is
    // too ambiguous and tested below as a non-match.
    expect(isServerErrorMessage("status: internal server error")).toBe(true);
  });

  it("classifies provider HTTP 5xx wrapper errors as server errors", () => {
    expect(isServerErrorMessage("provider failed (HTTP 500): upstream apiKey is empty")).toBe(true);
  });

  it("does not classify prefixed plain internal server error status prose", () => {
    expect(isServerErrorMessage("Proxy notice: Status: Internal Server Error")).toBe(false);
  });
});

describe("HTTP 429 with overloaded message body", () => {
  // Some providers (Z.ai/GLM, Anthropic) return HTTP 429 with an
  // "overloaded" message when their model fleet is at capacity.
  // This is a transient server-side overload, not a per-account
  // rate limit — it should be classified as "overloaded" so the
  // runner retries with backoff instead of immediately falling
  // over to the next model.
  it("classifies 429 'temporarily overloaded' as overloaded, not rate_limit", () => {
    const raw = "429 The service may be temporarily overloaded, please try again later";
    expect(isOverloadedErrorMessage(raw)).toBe(true);
    expect(classifyFailoverReason(raw)).toBe("overloaded");
  });

  it("classifies 429 'overloaded' (bare) as overloaded", () => {
    const raw = "429 overloaded";
    expect(isOverloadedErrorMessage(raw)).toBe(true);
    expect(classifyFailoverReason(raw)).toBe("overloaded");
  });

  it("classifies 429 'model is at capacity' as overloaded", () => {
    const raw = "429 The selected model is at capacity";
    expect(isOverloadedErrorMessage(raw)).toBe(true);
    expect(classifyFailoverReason(raw)).toBe("overloaded");
  });

  it("still classifies 429 'rate limit exceeded' as rate_limit", () => {
    const raw = "429 Rate limit exceeded";
    expect(isRateLimitErrorMessage(raw)).toBe(true);
    expect(classifyFailoverReason(raw)).toBe("rate_limit");
  });

  it("still classifies 429 'too many requests' as rate_limit", () => {
    const raw = "429 Too many requests";
    expect(isRateLimitErrorMessage(raw)).toBe(true);
    expect(classifyFailoverReason(raw)).toBe("rate_limit");
  });

  it("still classifies 429 billing messages as billing", () => {
    const raw =
      '429 {"code":1311,"message":"The model you requested is not available in your current plan"}';
    expect(classifyFailoverReason(raw)).toBe("billing");
  });
});

describe("generic assistant error text classification (#93931)", () => {
  it("classifies the generic 'LLM request failed.' as a timeout (transient)", () => {
    // The generic error text wraps provider availability failures (model not
    // loaded, endpoint unreachable) that should engage retry/fallback.
    expect(classifyFailoverReason("LLM request failed.")).toBe("timeout");
  });

  it("classifies lowercase 'llm request failed.' as a timeout", () => {
    expect(classifyFailoverReason("llm request failed.")).toBe("timeout");
  });

  it("does NOT match 'LLM request failed:' variants as timeout via this pattern", () => {
    // Variants with specific reasons should be classified by their own patterns,
    // not by the generic LLM request failed match. The schema rejection variant
    // is a format error, not a transient timeout.
    expect(
      isTimeoutErrorMessage(
        "LLM request failed: provider rejected the request schema or tool payload.",
      ),
    ).toBe(false);
  });

  it("does NOT match 'LLM request failed: connection refused' as timeout via this exact-match pattern", () => {
    // The connection-refused variant is a sanitized user-facing string, not
    // the raw error that cron/failover classifiers see. The exact-match regex
    // /^llm request failed\.$/i should NOT match it because of the colon suffix.
    expect(
      isTimeoutErrorMessage("LLM request failed: connection refused by the provider endpoint."),
    ).toBe(false);
  });
});
