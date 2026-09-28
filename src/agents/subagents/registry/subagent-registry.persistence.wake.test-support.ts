import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import type { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import {
  createDeliveredWake,
  observeSubagentRequesterWake,
} from "./subagent-registry.persistence.test-support.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry.store.sqlite.js";

type WakeParams = Parameters<typeof maybeWakeRequesterAfterAllChildrenSettled>[0];

export function registerStaleRequesterWakeBatchTests({
  getModules,
  withRegistryState,
  settleOwnedWork,
}: {
  getModules: () => {
    mod: typeof import("./subagent-registry.test-helpers.js");
    requesterSettleModule: typeof import("../announce/subagent-announce.requester-settle-wake.js");
    bindGatewayContextResolver: typeof import("../../../plugins/runtime/gateway-request-scope.js").bindGatewayContextResolver;
  };
  withRegistryState: (run: () => Promise<void>) => Promise<void>;
  settleOwnedWork: () => Promise<void> | undefined;
}) {
  const readPersistedRun = (runId: string) => loadSubagentRegistryFromSqlite().get(runId);
  it.each([
    "transition",
    "completion",
    "rejection",
    "closed-empty",
    "closed-transition",
    "closed-retryable",
    "closed-permanent",
  ] as const)(
    "rejects the whole stale batch when only a sibling closes or is replaced: %s",
    async (settlement) => {
      const { mod, requesterSettleModule, bindGatewayContextResolver } = getModules();
      const oldDone = createDeferredCore<boolean>();
      let oldParams: WakeParams | undefined;
      let siblingGatewayOpen = true;
      const anchorGateway = { resolveGatewayContext: () => anchorGateway as never };
      const nextGateway = { resolveGatewayContext: () => nextGateway as never };
      vi.useFakeTimers();
      try {
        await withRegistryState(async () => {
          try {
            const batch = ["run-batch-anchor", "run-batch-sibling"].map((runId, index) =>
              createDeliveredWake(runId, {
                status: "pending",
                attemptCount: 0,
                batchRunIds: ["run-batch-anchor", "run-batch-sibling"],
                rearmGeneration: 1,
                ...(index === 1 ? { nextAttemptAt: Date.now() + 30_000 } : {}),
              }),
            );
            const { run: wakeRequester, waitForCalls } = observeSubagentRequesterWake((params) => {
              oldParams ??= params;
              return oldDone.promise;
            });
            vi.spyOn(
              requesterSettleModule,
              "maybeWakeRequesterAfterAllChildrenSettled",
            ).mockImplementation(wakeRequester);
            saveSubagentRegistryToSqlite(new Map(batch.map((entry) => [entry.runId, entry])));
            mod.initSubagentRegistry();
            const anchor = mod.getSubagentRunByRunId("run-batch-anchor")!;
            const sibling = mod.getSubagentRunByRunId("run-batch-sibling")!;
            bindGatewayContextResolver(anchor, () => anchorGateway as never);
            bindGatewayContextResolver(sibling, () =>
              siblingGatewayOpen ? (anchorGateway as never) : undefined,
            );
            mod.activateSubagentRegistry(() => anchorGateway as never);
            await waitForCalls(1);
            expect(wakeRequester).toHaveBeenCalledOnce();
            expect(oldParams?.settledEntry).toBe(anchor);

            siblingGatewayOpen = false;
            const beforeActivation = settlement.startsWith("closed-");
            if (!beforeActivation) {
              mod.activateSubagentRegistry(() => nextGateway as never);
            }
            const replacement = mod.getSubagentRunByRunId(sibling.runId)!;
            expect(mod.getSubagentRunByRunId(anchor.runId)).toBe(anchor);
            expect(replacement === sibling).toBe(beforeActivation);
            const expected = [anchor, replacement].map((entry) =>
              structuredClone(entry.requesterSettleWake),
            );
            if (settlement.endsWith("transition")) {
              await oldParams!.transitionBatch([anchor, sibling], {
                ...expected[0]!,
                attemptCount: 99,
              });
            } else if (settlement === "rejection") {
              oldDone.reject(new Error("old mixed-owner dispatch failed"));
              await vi.advanceTimersByTimeAsync(0);
            } else {
              await oldParams!.completeBatch(
                [anchor, sibling],
                1,
                settlement === "completion" || settlement === "closed-empty"
                  ? undefined
                  : {
                      delivered: false,
                      path: "direct",
                      disposition:
                        settlement === "closed-permanent" ? "permanent_failure" : "retryable",
                    },
              );
            }
            expect([anchor, replacement].map((entry) => entry.requesterSettleWake)).toEqual(
              expected,
            );
            expect(readPersistedRun(sibling.runId)?.requesterSettleWake).toEqual(expected[1]);
            if (settlement === "completion" || settlement === "closed-empty") {
              oldDone.resolve(false);
              await settleOwnedWork();
              if (beforeActivation) {
                mod.activateSubagentRegistry(() => nextGateway as never);
                await settleOwnedWork();
              }
              // The old no-wake decision must not clear only the surviving member
              // when a deferred commit crosses its first retry deadline.
              await vi.advanceTimersByTimeAsync(30_000);
              await settleOwnedWork();
              expect(anchor.requesterSettleWake).toEqual(expected[0]);
              expect(readPersistedRun(anchor.runId)?.requesterSettleWake).toEqual(expected[0]);

              await mod.testing.runSweeperTickForTests();
              await settleOwnedWork();
              const freshParams = wakeRequester.mock.calls.findLast(
                ([params]) => params.settledEntry === anchor,
              )?.[0];
              expect(freshParams).toBeDefined();
              expect(freshParams).not.toBe(oldParams);
              await freshParams!.completeBatch([anchor], 1);
              expect(anchor.requesterSettleWake).toBeUndefined();
              expect(readPersistedRun(anchor.runId)?.requesterSettleWake).toBeUndefined();
              expect(readPersistedRun(sibling.runId)?.requesterSettleWake).toEqual(expected[1]);
            }
          } finally {
            oldDone.resolve(false);
            await vi.advanceTimersByTimeAsync(0);
          }
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );
}
