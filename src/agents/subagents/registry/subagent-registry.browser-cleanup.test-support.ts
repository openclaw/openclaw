import { expect, it, onTestFinished, vi, type Mock } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../../../browser-lifecycle-cleanup.js";
import type { closeTrackedBrowserTabsForSessions as CloseTabs } from "../../../plugin-sdk/browser-maintenance.js";
import * as gatewayWorkAdmission from "../../../process/gateway-work-admission.js";
import { observeAsyncWorkScopeRuns } from "../../../shared/async-work-scope.test-support.js";
import type { SubagentRegistryHarness } from "../../subagent-test-fixtures.test-helpers.js";
import type { createSubagentRegistryMockState } from "./subagent-registry.mock-state.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function createRootAdmissionObservation() {
  const admitted = new WeakMap<Promise<unknown>, { entered: boolean }>();
  const admissions = (
    [
      "runWithGatewayDetachedWorkAdmission",
      "runWithGatewayIndependentRootWorkAdmission",
      "runWithGatewayIndependentRootWorkContinuation",
      "runWithGatewayDetachedWorkContinuation",
    ] as const
  ).map((name) => {
    const original: typeof gatewayWorkAdmission.runWithGatewayIndependentRootWorkAdmission =
      gatewayWorkAdmission[name];
    return vi.spyOn(gatewayWorkAdmission, name).mockImplementation((run, origin, signal) => {
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
    });
  });
  return { admitted, admissions, subscribers: 0 };
}

let rootAdmissionObservation: ReturnType<typeof createRootAdmissionObservation> | undefined;

export function observeRootWork(): (keepObserving?: boolean) => Promise<void> {
  const rootWork = (rootAdmissionObservation ??= createRootAdmissionObservation());
  rootWork.subscribers += 1;
  // Detached completion resolves its result before this scope drains and releases its root.
  const scopeRuns = observeAsyncWorkScopeRuns();
  let disposed = false;
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    if (--rootWork.subscribers === 0) {
      rootWork.admissions.forEach((admission) => admission.mockRestore());
      rootAdmissionObservation = undefined;
    }
    scopeRuns[Symbol.dispose]();
  };
  onTestFinished(dispose);
  const observations = [...rootWork.admissions, scopeRuns];
  const positions = observations.map((observation) => observation.mock.results.length);
  return async (keepObserving = false) => {
    const failures: unknown[] = [];
    try {
      // A settled task writer can admit cleanup roots while another scope drains.
      while (
        observations.some((observation, i) => observation.mock.results.length > positions[i]!)
      ) {
        for (const [i, observation] of observations.entries()) {
          while (positions[i]! < observation.mock.results.length) {
            const result = observation.mock.results[positions[i]!]!;
            positions[i]! += 1;
            try {
              if (result.type === "throw") {
                throw result.value;
              }
              await result.value;
            } catch (error) {
              // Refused admission never owned cleanup; its caller handles rejection.
              if (rootWork.admitted.get(result.value)?.entered !== false) {
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
  it.each(["current owner", "session reset"] as const)(
    "rechecks the %s after browser activation in registered run completion",
    async (owner) => {
      const mod = getRegistry();
      vi.mocked(cleanupBrowserSessionsForLifecycleEnd).mockImplementation(
        (
          await vi.importActual<typeof import("../../../browser-lifecycle-cleanup.js")>(
            "../../../browser-lifecycle-cleanup.js",
          )
        ).cleanupBrowserSessionsForLifecycleEnd,
      );
      const closeTabs = vi.fn<typeof CloseTabs>().mockResolvedValue(1);
      const surface = {
        supportsSessionEntryCurrent: true,
        closeTrackedBrowserTabsForSessions: closeTabs,
      };
      const activation = createDeferred<typeof surface>();
      const activationEntered = createDeferred();
      loadBrowserMaintenanceSurface.mockImplementationOnce(() => {
        activationEntered.resolve();
        return activation.promise;
      });
      const settleRootWork = observeRootWork();
      const childSessionKey = "agent:main:subagent:child";
      const runId = "browser-old";

      try {
        await mod.registerSubagentRun({ runId, childSessionKey, task: "finish" });
        await activationEntered.promise;
        expect(gatewayWorkAdmission.getActiveGatewayRootWorkCount()).toBeGreaterThan(0);

        if (owner === "session reset") {
          (await mod.prepareSubagentSessionCleanupRevocation(childSessionKey))();
        }
      } finally {
        activation.resolve(surface);
        await settleRootWork();
      }

      expect(gatewayWorkAdmission.getActiveGatewayRootWorkCount()).toBe(0);
      expect(closeTabs).toHaveBeenCalledTimes(owner === "current owner" ? 1 : 0);
      if (owner === "current owner") {
        expect(closeTabs).toHaveBeenCalledWith(
          expect.objectContaining({ sessionKeys: [childSessionKey] }),
        );
        expect(findRequesterRun(runId)?.cleanupCompletedAt).toBeTypeOf("number");
      } else {
        expect(findRequesterRun(runId)?.execution).toMatchObject({
          status: "terminal",
          suppressSessionEffects: true,
        });
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
      await getRegistry().registerSubagentRun({ runId: "browser-warning", task: "finish" });
      await cleanupEntered.promise;
    } finally {
      await settleRootWork();
    }

    expect(gatewayWorkAdmission.getActiveGatewayRootWorkCount()).toBe(0);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalled();
    expect(findRequesterRun("browser-warning")?.cleanupCompletedAt).toBeTypeOf("number");
  });
}
