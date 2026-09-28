import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as gatewayCallRuntime from "../gateway/call.js";
import { createDeferredCore } from "../shared/deferred.js";
import { waitForAgentRunsToDrain } from "./run-wait.js";

const callGatewayMock = vi.spyOn(gatewayCallRuntime, "callGateway");
afterAll(() => callGatewayMock.mockRestore());
beforeEach(() => callGatewayMock.mockReset());

describe("asynchronous pending-run observation", () => {
  it("awaits fresh pending-run observations before dispatching successor waits", async () => {
    const initial = createDeferredCore<Iterable<string>>();
    const successor = createDeferredCore<Iterable<string>>();
    const refreshing = createDeferredCore();
    let reads = 0;
    callGatewayMock.mockResolvedValue({ status: "ok" });
    const pending = waitForAgentRunsToDrain({
      timeoutMs: 1_000,
      getPendingRunIds: async () => {
        reads++;
        if (reads === 1) {
          return await initial.promise;
        }
        if (reads === 2) {
          refreshing.resolve();
          return await successor.promise;
        }
        return [];
      },
    });
    void pending.catch(() => {});
    try {
      expect(callGatewayMock).not.toHaveBeenCalled();
      initial.resolve(["first"]);
      expect(
        await Promise.race([
          refreshing.promise.then(() => "refreshing"),
          pending.then(() => "done"),
        ]),
      ).toBe("refreshing");
      expect(callGatewayMock).toHaveBeenCalledTimes(1);
      expect(callGatewayMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          method: "agent.wait",
          params: expect.objectContaining({ runId: "first" }),
        }),
      );
      successor.resolve(["successor"]);
      expect(await pending).toMatchObject({ timedOut: false, pendingRunIds: [] });
      expect(callGatewayMock).toHaveBeenCalledTimes(2);
      expect(callGatewayMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          method: "agent.wait",
          params: expect.objectContaining({ runId: "successor" }),
        }),
      );
    } finally {
      initial.resolve([]);
      successor.resolve([]);
      await pending.catch(() => {});
    }
  });

  it.each([false, true])(
    "does not treat a refused observation as drained (refresh: %s)",
    async (refresh) => {
      const failure = new Error("registry read admission ended");
      callGatewayMock.mockResolvedValue({ status: "ok" });
      await expect(
        waitForAgentRunsToDrain({
          timeoutMs: 1_000,
          ...(refresh ? { initialPendingRunIds: ["first"] } : {}),
          getPendingRunIds: async () => {
            throw failure;
          },
        }),
      ).rejects.toBe(failure);
      expect(callGatewayMock).toHaveBeenCalledTimes(refresh ? 1 : 0);
    },
  );
});
