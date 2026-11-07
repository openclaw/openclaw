import { describe, expect, it } from "vitest";
import { classifyQwenFailoverReason } from "./failover.js";

describe("Qwen quota error semantics", () => {
  it("distinguishes transient quotas, exhausted credit, and errors owned by shared failover", () => {
    const cases: [
      Parameters<typeof classifyQwenFailoverReason>[0],
      ReturnType<typeof classifyQwenFailoverReason>,
    ][] = [];
    const messages = [
      "Allocated quota exceeded, please increase your quota limit.",
      "You exceeded your current quota, please check your plan and billing details.",
    ];
    for (const code of ["insufficient_quota", "Throttling.AllocationQuota"]) {
      for (const errorMessage of messages) {
        cases.push(
          [{ status: 429, code, errorMessage }, "rate_limit"],
          [{ status: 429, errorType: code, errorMessage }, "rate_limit"],
        );
      }
      cases.push(
        [{ status: 429, code, errorMessage: "Free allocated quota exceeded." }, "billing"],
        // Bailian reuses insufficient_quota for TPS/TPM throttles (#148236):
        // unmarked quota messages cool down instead of disabling the profile.
        [{ status: 429, code, errorMessage: "Unknown quota condition" }, "rate_limit"],
        [{ status: 429, code, errorMessage: "Throttling.AllocationQuota" }, "rate_limit"],
        [{ status: 429, code, errorMessage: "PrepaidBillOverdue: quota frozen" }, "billing"],
        [{ status: 429, code, errorMessage: "insufficient_balance, top up required" }, "billing"],
      );
    }
    for (const code of ["PrepaidBillOverdue", "PostpaidBillOverdue"]) {
      cases.push([{ status: 429, code, errorMessage: "Provider refusal" }, "billing"]);
    }
    const errorMessage = messages[0]!;
    for (const context of [
      { status: 403, code: "insufficient_quota", errorMessage },
      { status: 429, code: "unrecognized_code", errorMessage },
      { status: 429, errorMessage },
      { code: "insufficient_quota", errorMessage },
    ]) {
      cases.push([context, undefined]);
    }
    for (const [context, expected] of cases) {
      expect(classifyQwenFailoverReason(context), JSON.stringify(context)).toBe(expected);
    }
  });
});
