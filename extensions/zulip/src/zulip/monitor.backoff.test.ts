import { describe, expect, it, vi } from "vitest";
import { computeZulipMonitorBackoffMs } from "./monitor.js";

describe("computeZulipMonitorBackoffMs", () => {
  it("respects retry-after when higher than exponential", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(
      computeZulipMonitorBackoffMs({
        attempt: 1,
        status: 429,
        retryAfterMs: 10_000,
      }),
    ).toBeGreaterThanOrEqual(10_000);
    vi.restoreAllMocks();
  });

  it("increases with attempts for 429", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const a1 = computeZulipMonitorBackoffMs({ attempt: 1, status: 429 });
    const a2 = computeZulipMonitorBackoffMs({ attempt: 2, status: 429 });
    const a3 = computeZulipMonitorBackoffMs({ attempt: 3, status: 429 });
    expect(a2).toBeGreaterThan(a1);
    expect(a3).toBeGreaterThan(a2);
    vi.restoreAllMocks();
  });
});
