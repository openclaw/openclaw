import { describe, expect, it } from "vitest";
import { classifyQwenFailoverReason } from "./failover.js";

describe("Qwen quota error semantics", () => {
  it.each(["insufficient_quota", "Throttling.AllocationQuota"])(
    "refines documented throttle messages for %s without treating free-credit exhaustion as transient",
    (code) => {
      for (const errorMessage of [
        "Allocated quota exceeded, please increase your quota limit.",
        "You exceeded your current quota, please check your plan and billing details.",
      ]) {
        expect(classifyQwenFailoverReason({ status: 429, code, errorMessage })).toBe("rate_limit");
        expect(classifyQwenFailoverReason({ status: 429, errorType: code, errorMessage })).toBe(
          "rate_limit",
        );
      }
      expect(
        classifyQwenFailoverReason({
          status: 429,
          code,
          errorMessage: "Free allocated quota exceeded.",
        }),
      ).toBe("billing");
      expect(
        classifyQwenFailoverReason({ status: 429, code, errorMessage: "Unknown quota condition" }),
      ).toBeUndefined();
    },
  );

  it.each(["PrepaidBillOverdue", "PostpaidBillOverdue"])("recognizes explicit %s", (code) => {
    expect(
      classifyQwenFailoverReason({ status: 429, code, errorMessage: "Provider refusal" }),
    ).toBe("billing");
  });

  it("leaves other statuses, unrelated codes, and unstructured text to the existing owner", () => {
    const errorMessage = "Allocated quota exceeded, please increase your quota limit.";
    for (const context of [
      { status: 403, code: "insufficient_quota", errorMessage },
      { status: 429, code: "unrecognized_code", errorMessage },
      { status: 429, errorMessage },
      { code: "insufficient_quota", errorMessage },
    ]) {
      expect(classifyQwenFailoverReason(context)).toBeUndefined();
    }
  });
});
