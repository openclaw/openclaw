// Covers provider-specific failover matcher regressions.
import { describe, expect, it } from "vitest";
import {
  classifyFailoverReason,
  isAuthErrorMessage,
  isBillingErrorMessage,
  isProviderCompletedErrorFinishReasonMessage,
  isRateLimitErrorMessage,
  isServerErrorMessage,
  isTimeoutErrorMessage,
} from "./classify.js";

describe("Z.ai vendor error codes (#48988)", () => {
  describe("error 1311 — model not included in subscription plan", () => {
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
  });

  describe("error 1113 — wrong endpoint or invalid credentials", () => {
    it("does not misclassify 1113 as rate_limit", () => {
      const raw = '{"code":1113,"message":"invalid api endpoint or credentials"}';
      expect(isRateLimitErrorMessage(raw)).toBe(false);
    });

    it("does not misclassify 1113 as billing", () => {
      const raw = '{"code":1113,"message":"invalid api endpoint or credentials"}';
      expect(isBillingErrorMessage(raw)).toBe(false);
    });
  });
});

describe("Google invalid API key errors (#114784)", () => {
  it("classifies Google Generative AI's invalid-key response as auth", () => {
    const raw =
      "Google Generative AI API error (400): API key not valid. Please pass a valid API key. [code=INVALID_ARGUMENT]";

    expect(isAuthErrorMessage(raw)).toBe(true);
    expect(classifyFailoverReason(raw)).toBe("auth");
  });

  it("does not treat unrelated Google invalid arguments as auth", () => {
    const raw =
      "Google Generative AI API error (400): Request contains an invalid argument. [code=INVALID_ARGUMENT]";

    expect(isAuthErrorMessage(raw)).toBe(false);
    expect(classifyFailoverReason(raw)).toBeNull();
    expect(isAuthErrorMessage("API key invalidation policy updated")).toBe(false);
    expect(isAuthErrorMessage("INVALID API KEYSTORE configuration")).toBe(false);
  });
});
describe("Chinese provider overload messages", () => {
  const ZHIPU_OVERLOAD = "[1305][该模型当前访问量过大，请您稍后再试]";

  it("does not misclassify the GLM overload body as rate limit or auth", () => {
    expect(isRateLimitErrorMessage(ZHIPU_OVERLOAD)).toBe(false);
    expect(isAuthErrorMessage(ZHIPU_OVERLOAD)).toBe(false);
  });
});

describe("Volcengine Coding Plan subscription errors", () => {
  it("classifies InvalidSubscription as billing before auth or rate limit", () => {
    const raw =
      '{"error":{"code":"InvalidSubscription","message":"Your account does not have a valid CodingPlan subscription, or your subscription has expired."}}';
    expect(isRateLimitErrorMessage(raw)).toBe(false);
    expect(classifyFailoverReason(raw)).toBe("billing");
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

describe("provider-completed finish_reason error (#109218)", () => {
  it("matches bare finish/stop error reasons as provider-completed failures", () => {
    expect(isProviderCompletedErrorFinishReasonMessage("Provider finish_reason: error")).toBe(true);
    expect(isTimeoutErrorMessage("Provider finish_reason: error")).toBe(false);
    expect(classifyFailoverReason("Provider finish_reason: error")).toBe("server_error");
  });

  it("keeps abort/network/malformed finish reasons in the timeout lane", () => {
    for (const sample of [
      "Provider finish_reason: abort",
      "Provider finish_reason: network_error",
      "Provider finish_reason: malformed_response",
    ]) {
      expect(isProviderCompletedErrorFinishReasonMessage(sample)).toBe(false);
      expect(isTimeoutErrorMessage(sample)).toBe(true);
      expect(classifyFailoverReason(sample)).toBe("timeout");
    }
  });
});
