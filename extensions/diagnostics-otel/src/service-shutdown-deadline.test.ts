// Diagnostics OTel tests cover the bounded provider shutdown path.
import { describe, expect, it, vi } from "vitest";
import { settleStopsWithinDeadline } from "./service.js";

describe("settleStopsWithinDeadline", () => {
  it("waits for fast stops and reports their failures", async () => {
    const failure = new Error("flush failed");
    const failures = await settleStopsWithinDeadline("diagnostics-otel provider", [
      () => undefined,
      async () => {
        throw failure;
      },
      null,
    ]);

    expect(failures).toEqual([failure]);
  });

  it("stops waiting when a provider shutdown never settles", async () => {
    const neverSettles = vi.fn(() => new Promise<void>(() => {}));

    const startedAt = Date.now();
    const failures = await settleStopsWithinDeadline(
      "diagnostics-otel provider",
      [neverSettles],
      20,
    );

    expect(neverSettles).toHaveBeenCalledTimes(1);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toContain("diagnostics-otel provider shutdown exceeded 20ms");
  });
});
