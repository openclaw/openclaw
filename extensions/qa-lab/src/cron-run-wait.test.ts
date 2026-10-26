import { describe, expect, it, vi } from "vitest";
import { waitForCronRunCompletion } from "./cron-run-wait.js";

type WaitParams = Parameters<typeof waitForCronRunCompletion>[0];
const gateway = () => vi.fn<WaitParams["callGateway"]>();
const olderRun = { entries: [{ ts: 100, status: "ok", summary: "older run" }] };
const newRun = { ts: 180, status: "ok", summary: "new run" };
const wait = (callGateway: WaitParams["callGateway"], overrides: Partial<WaitParams> = {}) =>
  waitForCronRunCompletion({
    callGateway,
    jobId: "dreaming-job",
    afterTs: 150,
    timeoutMs: 100,
    intervalMs: 0,
    ...overrides,
  });

function expectCall(
  callGateway: ReturnType<typeof gateway>,
  index: number,
  id: string,
  timeoutMs: unknown,
) {
  expect(callGateway).toHaveBeenNthCalledWith(
    index,
    "cron.runs",
    { id, limit: 20, sortDir: "desc" },
    { timeoutMs },
  );
}

describe("waitForCronRunCompletion", () => {
  it("ignores older entries and returns the newly finished run", async () => {
    const callGateway = gateway()
      .mockResolvedValueOnce(olderRun)
      .mockResolvedValueOnce({ entries: [newRun] });
    expect(await wait(callGateway)).toEqual(newRun);
    expectCall(callGateway, 1, "dreaming-job", expect.any(Number));
    const firstTimeoutMs = callGateway.mock.calls[0]?.[2]?.timeoutMs;
    expect(firstTimeoutMs).toBeGreaterThan(0);
    expect(firstTimeoutMs).toBeLessThanOrEqual(100);
  });

  it.each([0, Number.MAX_SAFE_INTEGER])(
    "times out with polling interval %s",
    async (intervalMs) => {
      await expect(
        wait(gateway().mockResolvedValue(olderRun), { timeoutMs: 5, intervalMs }),
      ).rejects.toThrow(/timed out waiting for cron run completion/);
    },
  );

  it("allows live CLI scenarios to extend the gateway call deadline", async () => {
    const callGateway = gateway().mockResolvedValue({ entries: [newRun] });

    await wait(callGateway, {
      jobId: "slow-cli-job",
      timeoutMs: 120_000,
      gatewayCallTimeoutMs: 90_000,
    });

    expectCall(callGateway, 1, "slow-cli-job", 90_000);
  });

  it("caps each gateway call at the remaining overall deadline", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const callGateway = gateway()
      .mockImplementationOnce(async () => {
        now = 1_080;
        return olderRun;
      })
      .mockResolvedValueOnce({ entries: [newRun] });

    try {
      await wait(callGateway, {
        jobId: "bounded-call-job",
        gatewayCallTimeoutMs: 90,
      });

      expectCall(callGateway, 2, "bounded-call-job", 20);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
