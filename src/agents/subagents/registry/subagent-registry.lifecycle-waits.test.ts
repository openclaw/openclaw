import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createLifecycleAgentCallWaits } from "./subagent-registry.lifecycle-waits.test-support.js";

const mocks = vi.hoisted(() => ({
  settleRootWork: vi.fn<(keepObserving?: boolean) => Promise<void>>(),
  listRuns: vi.fn<
    () => Array<{
      runId: string;
      cleanupHandled: boolean;
      delivery?: { status: string; payload?: string };
    }>
  >(),
}));
vi.mock("./subagent-registry.browser-cleanup.test-support.js", () => ({
  observeRootWork: () => mocks.settleRootWork,
}));
vi.mock("./subagent-registry.test-helpers.js", () => ({
  listSubagentRunsForRequester: mocks.listRuns,
}));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("joins deferred publication without spending retry time or retiring later observation", async () => {
  vi.useFakeTimers();
  let count = 0;
  let publication = createDeferred();
  const row = {
    runId: "run",
    cleanupHandled: true,
    delivery: { status: "pending", payload: "final" },
  };
  mocks.listRuns.mockReturnValue([row]);
  mocks.settleRootWork.mockImplementation(async (keepObserving) => {
    if (keepObserving) {
      await publication.promise;
    }
  });
  const waits = createLifecycleAgentCallWaits("agent:main:main", () => count);
  const enter = async () => {
    const entered = waits.waitForAgentCallCount(++count);
    waits.notifyAgentCall();
    await entered;
  };
  try {
    await enter();
    let outcome = "pending";
    const waiting = waits.waitForCleanupHandledFalse("run").then(
      () => {
        outcome = "published";
      },
      () => {
        outcome = "rejected";
      },
    );
    await vi.runAllTimersAsync();
    expect(outcome).toBe("pending");
    expect(mocks.listRuns).not.toHaveBeenCalled();
    row.cleanupHandled = false;
    publication.resolve();
    await waiting;
    expect(outcome).toBe("published");
    expect(mocks.settleRootWork).toHaveBeenCalledWith(true);
    expect(mocks.settleRootWork).not.toHaveBeenCalledWith();

    // A corrected terminal receipt owns a new producer after the first join.
    publication = createDeferred();
    row.cleanupHandled = true;
    await enter();
    outcome = "pending";
    const corrected = waits.waitForCleanupHandledFalse("run").then(() => {
      outcome = "published";
    });
    await vi.runAllTimersAsync();
    expect(outcome).toBe("pending");
    row.cleanupHandled = false;
    publication.resolve();
    await corrected;
    expect(outcome).toBe("published");
  } finally {
    publication.resolve();
    await waits.settle();
  }
});
