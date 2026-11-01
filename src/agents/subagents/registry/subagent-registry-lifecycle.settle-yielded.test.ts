import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as runtimeConfig from "../../../config/runtime-snapshot.js";
import { resetGatewayWorkAdmission } from "../../../process/gateway-work-admission.js";
import * as ended from "./subagent-lifecycle-events.js";
import { persistSubagentSessionTiming } from "./subagent-registry-helpers.js";
import {
  createLifecycleControllerFixture,
  createRunEntry,
  mutateLifecycleRun,
  readLifecycleRun,
  type RunEntryOverrides,
} from "./subagent-registry-lifecycle-controller.test-support.js";
import type { SubagentCompletionRequest } from "./subagent-registry.types.js";

vi.mock("./subagent-registry-helpers.js", { spy: true });

beforeEach(() => {
  resetGatewayWorkAdmission();
  // Completion captures watcher paths from the prepared runtime config.
  runtimeConfig.setRuntimeConfigSnapshot({});
  vi.mocked(persistSubagentSessionTiming).mockResolvedValue(undefined);
});
afterEach(runtimeConfig.clearRuntimeConfigSnapshot);

const failedOutcome = { status: "error", error: "no continuation can reach this run" } as const;
function fixture(overrides: RunEntryOverrides = {}) {
  const entry = createRunEntry({ endedAt: 4_000, pauseReason: "sessions_yield", ...overrides });
  const controller = createLifecycleControllerFixture(
    { entry },
    {
      callGateway: async () => {
        throw new Error("Unexpected Gateway call");
      },
      cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
      ownersByEntry: new Map(),
    },
  );
  const complete = (request: Omit<Partial<SubagentCompletionRequest>, "runId"> = {}) =>
    controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: failedOutcome,
      reason: ended.SUBAGENT_ENDED_REASON_ERROR,
      triggerCleanup: false,
      settleYielded: true,
      ...request,
    });
  return { entry, controller, complete, read: () => readLifecycleRun(entry) };
}

it("completes a yielded row only when the request opts in", async () => {
  const { complete, read } = fixture();
  await complete({ settleYielded: undefined });
  expect(read().pauseReason).toBe("sessions_yield");
  expect(read().execution.outcome).toBeUndefined();
  await complete();
  expect(read().pauseReason).toBeUndefined();
  expect(read().execution.outcome).toMatchObject(failedOutcome);
});

it.each([true, false])("ignores a resumed row (snapshot=%s)", async (withSnapshot) => {
  const { entry, complete, read } = fixture();
  const staleSnapshot = structuredClone(entry);
  await mutateLifecycleRun(entry, (draft) => {
    draft.pauseReason = undefined;
    draft.execution = { status: "running", startedAt: 5_000 };
  });
  await complete(withSnapshot ? { expectedEntry: staleSnapshot } : {});
  expect(read().pauseReason).toBeUndefined();
  expect(read().execution).toMatchObject({ status: "running", startedAt: 5_000 });
  expect(read().execution.outcome).toBeUndefined();
});

it("leaves an already finished row untouched by a late settle request", async () => {
  const { complete, read } = fixture({ pauseReason: undefined, outcome: { status: "ok" } });
  await complete();
  expect(read().execution.outcome).toEqual({ status: "ok" });
});

it("keeps a kill claim published while the settle request is preparing", async () => {
  const { entry, controller, complete, read } = fixture();
  const claim = { requestedAt: 6_000, reason: "operator requested stop" };
  const sweeperSnapshot = read();
  // The claim lands after the sweeper read, while completion waits for its lock.
  const acquireLock = controller.acquireTerminalCompletionLock.bind(controller);
  using lock = vi.spyOn(controller, "acquireTerminalCompletionLock");
  lock.mockImplementationOnce(async (runId) => {
    await mutateLifecycleRun(entry, (draft) => {
      draft.killIntent = claim;
    });
    return acquireLock(runId);
  });
  await complete({ expectedEntry: sweeperSnapshot });
  expect(read().killIntent).toEqual(claim);
  expect(read().pauseReason).toBe("sessions_yield");
  expect(read().execution.outcome).toBeUndefined();
  await complete({
    endedAt: 7_000,
    outcome: { status: "error", error: claim.reason },
    reason: ended.SUBAGENT_ENDED_REASON_KILLED,
    settleYielded: undefined,
  });
  expect(read()).toMatchObject({
    endedReason: ended.SUBAGENT_ENDED_REASON_KILLED,
    execution: { outcome: { status: "error", error: claim.reason } },
  });
});
