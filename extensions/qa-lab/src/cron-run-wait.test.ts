// Qa Lab tests cover cron run wait plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { waitForCronRunCompletion } from "./cron-run-wait.js";

type WaitParams = Parameters<typeof waitForCronRunCompletion>[0];
const gateway = () => vi.fn<WaitParams["callGateway"]>();
const olderRun = { entries: [{ ts: 100, status: "ok", summary: "older run" }] };
const wait = (callGateway: WaitParams["callGateway"], overrides: Partial<WaitParams> = {}) =>
  waitForCronRunCompletion({
    callGateway,
    jobId: "dreaming-job",
    afterTs: 150,
    timeoutMs: 100,
    intervalMs: 0,
    ...overrides,
  });

describe("waitForCronRunCompletion", () => {
  it("ignores older entries and returns the newly finished run", async () => {
    const callGateway = gateway()
      .mockResolvedValueOnce(olderRun)
      .mockResolvedValueOnce({
        entries: [{ ts: 180, status: "ok", summary: "new run" }],
      });

    const result = await wait(callGateway);

    expect(result).toEqual({ ts: 180, status: "ok", summary: "new run" });
    expect(callGateway).toHaveBeenNthCalledWith(
      1,
      "cron.runs",
      { id: "dreaming-job", limit: 20, sortDir: "desc" },
      { timeoutMs: expect.any(Number) },
    );
    const firstTimeoutMs = callGateway.mock.calls[0]?.[2]?.timeoutMs;
    expect(firstTimeoutMs).toBeGreaterThan(0);
    expect(firstTimeoutMs).toBeLessThanOrEqual(100);
  });

  it("surfaces recent run history on timeout", async () => {
    const callGateway = gateway().mockResolvedValue(olderRun);
    await expect(wait(callGateway, { timeoutMs: 5 })).rejects.toThrow(
      /timed out waiting for cron run completion/,
    );
  });

  it("allows live CLI scenarios to extend the gateway call deadline", async () => {
    const callGateway = gateway().mockResolvedValue({ entries: [{ ts: 180, status: "ok" }] });

    await wait(callGateway, {
      jobId: "slow-cli-job",
      timeoutMs: 120_000,
      gatewayCallTimeoutMs: 90_000,
    });

    expect(callGateway).toHaveBeenCalledWith(
      "cron.runs",
      { id: "slow-cli-job", limit: 20, sortDir: "desc" },
      { timeoutMs: 90_000 },
    );
  });

  it("caps each gateway call at the remaining overall deadline", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const callGateway = gateway()
      .mockImplementationOnce(async () => {
        now = 1_080;
        return { entries: [{ ts: 100, status: "ok", summary: "older run" }] };
      })
      .mockResolvedValueOnce({ entries: [{ ts: 180, status: "ok" }] });

    try {
      await wait(callGateway, {
        jobId: "bounded-call-job",
        gatewayCallTimeoutMs: 90,
      });

      expect(callGateway).toHaveBeenNthCalledWith(
        2,
        "cron.runs",
        { id: "bounded-call-job", limit: 20, sortDir: "desc" },
        { timeoutMs: 20 },
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("keeps oversized poll intervals within the overall timeout", async () => {
    const callGateway = gateway().mockResolvedValue(olderRun);

    await expect(
      wait(callGateway, {
        timeoutMs: 5,
        intervalMs: Number.MAX_SAFE_INTEGER,
      }),
    ).rejects.toThrow(/timed out waiting for cron run completion/);
  });
});
