import { describe, expect, it } from "vitest";
import {
  resolveFeishuWebhookAnomalyDefaultsForTest,
  resolveFeishuWebhookRateLimitDefaultsForTest
} from "./monitor.state.js";
describe("feishu monitor state defaults", () => {
  it("falls back to hard defaults when sdk defaults are missing", () => {
    expect(resolveFeishuWebhookRateLimitDefaultsForTest(void 0)).toEqual({
      windowMs: 6e4,
      maxRequests: 120,
      maxTrackedKeys: 4096
    });
    expect(resolveFeishuWebhookAnomalyDefaultsForTest(void 0)).toEqual({
      maxTrackedKeys: 4096,
      ttlMs: 216e5,
      logEvery: 25
    });
  });
  it("keeps valid sdk values and repairs invalid fields", () => {
    expect(
      resolveFeishuWebhookRateLimitDefaultsForTest({
        windowMs: 45e3,
        maxRequests: 0,
        maxTrackedKeys: -1
      })
    ).toEqual({
      windowMs: 45e3,
      maxRequests: 120,
      maxTrackedKeys: 4096
    });
    expect(
      resolveFeishuWebhookAnomalyDefaultsForTest({
        maxTrackedKeys: 2048,
        ttlMs: Number.NaN,
        logEvery: 10
      })
    ).toEqual({
      maxTrackedKeys: 2048,
      ttlMs: 216e5,
      logEvery: 10
    });
  });
});
