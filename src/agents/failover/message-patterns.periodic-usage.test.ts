import { describe, expect, it } from "vitest";
import { isPeriodicUsageLimitErrorMessage } from "./message-patterns.js";

describe("isPeriodicUsageLimitErrorMessage", () => {
  it("recognizes periodic usage limits in English and Chinese", () => {
    // Zhipu 1310 wording, already covered by the English pattern.
    expect(
      isPeriodicUsageLimitErrorMessage(
        "Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-03-06",
      ),
    ).toBe(true);
    // MiniMax Token Plan 2056, reported in #172165 with no Retry-After header.
    expect(
      isPeriodicUsageLimitErrorMessage(
        '{"error":{"message":"已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)","type":"rate_limit_error"},"type":"error"}',
      ),
    ).toBe(true);
  });

  it("keeps transient and unrelated Chinese limits out of the periodic path", () => {
    expect(isPeriodicUsageLimitErrorMessage("请求过于频繁，请稍后重试")).toBe(false);
    // A context/length cap is not a usage window.
    expect(isPeriodicUsageLimitErrorMessage("上下文长度上限为 128k tokens")).toBe(false);
  });
});
