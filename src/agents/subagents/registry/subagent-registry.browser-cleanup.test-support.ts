import { expect, it, onTestFinished, vi, type Mock } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../../../browser-lifecycle-cleanup.js";
import * as gatewayWorkAdmission from "../../../process/gateway-work-admission.js";
import { observeAsyncWorkScopeRuns } from "../../../shared/async-work-scope.test-support.js";
import type { SubagentRegistryHarness } from "../../subagent-test-fixtures.test-helpers.js";
import type { createSubagentRegistryMockState } from "./subagent-registry.mock-state.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function createRootAdmissionObservation() {
  const admitted = new WeakMap<Promise<unknown>, { entered: boolean }>();
  const admissions = (
    [
      "runWithGatewayIndependentRootWorkAdmission",
      "runWithGatewayIndependentRootWorkContinuation",
    ] as const
  ).map((name) => {
    const original: typeof gatewayWorkAdmission.runWithGatewayIndependentRootWorkAdmission =
      gatewayWorkAdmission[name];
    const observe: typeof original = (run, origin, signal) => {
      const entry = { entered: false };
      const result = original(
        () => {
          entry.entered = true;
          return run();
        },
        origin,
        signal,
      );
      admitted.set(result, entry);
      return result;
    };
    return vi.spyOn(gatewayWorkAdmission, name).mockImplementation(observe);
  });
  return { admitted, admissions, subscribers: 0 };
}

let rootAdmissionObservation: ReturnType<typeof createRootAdmissionObservation> | undefined;

export function observeRootWork(): (keepObserving?: boolean) => Promise<void> {
  const rootWork = (rootAdmissionObservation ??= createRootAdmissionObservation());
  rootWork.subscribers += 1;
  const { admissions } = rootWork;
  // Detached completion resolves its result before this scope drains and releases its root.
  const scopeRuns = observeAsyncWorkScopeRuns();
  let disposed = false;
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    if (--rootWork.subscribers === 0) {
      for (const admission of admissions) {
        admission.mockRestore();
      }
      rootAdmissionObservation = undefined;
    }
    scopeRuns[Symbol.dispose]();
  };
  onTestFinished(dispose);
  const observations = [...admissions, scopeRuns];
  const positions = observations.map((observation) => observation.mock.results.length);
  return async (keepObserving = false) => {
    const failures: unknown[] = [];
    try {
      // A settled task writer can admit cleanup roots while another scope drains.
      while (
        observations.some(
          (observation, index) => observation.mock.results.length > positions[index]!,
        )
      ) {
        for (const [index, observation] of observations.entries()) {
          while (positions[index]! < observation.mock.results.length) {
            const result = observation.mock.results[positions[index]!]!;
            positions[index]! += 1;
            try {
              if (result.type === "throw") {
                throw result.value;
              }
              await result.value;
            } catch (error) {
              // A refused admission never owned cleanup; its caller handles that rejection.
              const admission = rootWork.admitted.get(result.value);
              if (admission?.entered !== false) {
                failures.push(error);
              }
            }
          }
        }
      }
    } finally {
      if (!keepObserving) {
        dispose();
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to settle subagent cleanup roots");
    }
  };
}

export function registerBrowserCleanupBoundaryTests({
  getRegistry,
  mocks,
  loadBrowserMaintenanceSurface,
  mockPendingAgentWait,
  findRequesterRun,
}: {
  getRegistry: () => SubagentRegistryHarness;
  mocks: Pick<
    ReturnType<typeof createSubagentRegistryMockState>,
    "cleanupBrowserSessionsForLifecycleEnd" | "runSubagentAnnounceFlow"
  >;
  loadBrowserMaintenanceSurface: Mock;
  mockPendingAgentWait: () => void;
  findRequesterRun: (runId: string) => SubagentRunRecord | undefined;
}): void {
  it.each(["current owner", "replacement row", "newer child generation", "session reset"] as const)(
    "rechecks the %s after browser activation in registered run completion",
    async (owner) => {
      const mod = getRegistry();
      const browser = await vi.importActual<typeof import("../../../browser-lifecycle-cleanup.js")>(
        "../../../browser-lifecycle-cleanup.js",
      );
      vi.mocked(cleanupBrowserSessionsForLifecycleEnd).mockImplementation(
        browser.cleanupBrowserSessionsForLifecycleEnd,
      );
      const closeTrackedBrowserTabsForSessions = vi
        .fn<
          typeof import("../../../plugin-sdk/browser-maintenance.js").closeTrackedBrowserTabsForSessions
        >()
        .mockResolvedValue(1);
      const surface = { closeTrackedBrowserTabsForSessions };
      const activation = createDeferred<typeof surface>();
      const activationEntered = createDeferred();
      loadBrowserMaintenanceSurface.mockImplementationOnce(() => {
        activationEntered.resolve();
        return activation.promise;
      });
      const settleRootWork = observeRootWork();
      const childSessionKey = "agent:main:subagent:child";
      const runId = "run-browser-activation-old";
      const successorRunId = owner === "replacement row" ? runId : "run-browser-activation-new";

      try {
        await mod.registerSubagentRun({ runId, childSessionKey, task: "finish browser work" });
        await activationEntered.promise;
        expect(loadBrowserMaintenanceSurface).toHaveBeenCalledOnce();
        expect(gatewayWorkAdmission.getActiveGatewayRootWorkCount()).toBeGreaterThan(0);

        if (owner === "session reset") {
          mod.prepareSubagentSessionCleanupRevocation(childSessionKey)();
        } else if (owner !== "current owner") {
          mockPendingAgentWait();
          await mod.registerSubagentRun({
            runId: successorRunId,
            childSessionKey,
            task: "continue using the same browser session",
          });
        }
      } finally {
        activation.resolve(surface);
        await settleRootWork();
      }

      expect(gatewayWorkAdmission.getActiveGatewayRootWorkCount()).toBe(0);
      expect(closeTrackedBrowserTabsForSessions).toHaveBeenCalledTimes(
        owner === "current owner" ? 1 : 0,
      );
      if (owner === "current owner") {
        expect(closeTrackedBrowserTabsForSessions).toHaveBeenCalledWith(
          expect.objectContaining({ sessionKeys: [childSessionKey] }),
        );
        expect(findRequesterRun(runId)?.cleanupCompletedAt).toBeTypeOf("number");
      } else if (owner === "session reset") {
        expect(findRequesterRun(runId)?.execution).toMatchObject({
          status: "terminal",
          suppressSessionEffects: true,
        });
      } else {
        expect(findRequesterRun(successorRunId)).toMatchObject({
          childSessionKey,
          execution: { status: "running" },
        });
        expect(findRequesterRun(successorRunId)?.cleanupCompletedAt).toBeUndefined();
      }
    },
  );

  it("continues completion announce cleanup when lifecycle cleanup fails", async () => {
    const cleanupEntered = createDeferred();
    mocks.cleanupBrowserSessionsForLifecycleEnd.mockImplementationOnce(async () => {
      cleanupEntered.resolve();
      throw new Error("browser cleanup unavailable");
    });
    const settleRootWork = observeRootWork();
    try {
      await getRegistry().registerSubagentRun({
        runId: "run-cleanup-warning",
        task: "finish despite cleanup warning",
      });
      await cleanupEntered.promise;
    } finally {
      await settleRootWork();
    }

    expect(gatewayWorkAdmission.getActiveGatewayRootWorkCount()).toBe(0);
    expect(mocks.cleanupBrowserSessionsForLifecycleEnd).toHaveBeenCalledOnce();
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledOnce();
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        childSessionKey: "agent:main:subagent:child",
        childRunId: "run-cleanup-warning",
        task: "finish despite cleanup warning",
      }),
    );
    expect(findRequesterRun("run-cleanup-warning")?.cleanupCompletedAt).toBeTypeOf("number");
  });
}
