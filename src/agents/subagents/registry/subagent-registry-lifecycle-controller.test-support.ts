import { vi } from "vitest";
import {
  SubagentLifecycleController,
  type SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle.js";
import { SubagentRegistryWriteError } from "./subagent-registry-persistence.js";
import { getLatestSubagentRunByChildSessionKeyFromRuns } from "./subagent-registry-queries.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type RequesterSettleWakeParams = Parameters<
  SubagentLifecycleOptions["maybeWakeRequesterAfterAllChildrenSettled"]
>[0];

export function createLifecycleControllerFixture(
  {
    entry,
    runs = new Map([[entry.runId, entry]]),
    ...overrides
  }: {
    entry: SubagentRunRecord;
    runs?: Map<string, SubagentRunRecord>;
  } & Partial<SubagentLifecycleOptions>,
  dependencies: Pick<
    SubagentLifecycleOptions,
    "callGateway" | "cleanupBrowserSessionsForLifecycleEnd"
  > & {
    ownersByEntry: WeakMap<
      SubagentRunRecord,
      Pick<SubagentLifecycleOptions, "runs" | "persistAsyncOrThrow">
    >;
  },
) {
  const params: SubagentLifecycleOptions = {
    runs,
    resumedRuns: new Set(),
    subagentAnnounceTimeoutMs: 1_000,
    getRuntimeConfig: () => ({}),
    persist: vi.fn(),
    persistOrThrow: vi.fn(),
    persistAsyncOrThrow: async (_context, publication, ...runIds) => {
      publication.assertCurrent();
      try {
        params.persistOrThrow(...runIds);
      } catch (error) {
        throw new SubagentRegistryWriteError("not-committed", error);
      }
      await Promise.resolve();
      publication.onCommitted?.();
    },
    clearPendingLifecycleError: vi.fn(),
    countPendingDescendantRuns: () => 0,
    getLatestRunForChildSession: (key, matches) =>
      getLatestSubagentRunByChildSessionKeyFromRuns(runs, key, matches) ?? null,
    suppressAnnounceForSteerRestart: () => false,
    shouldEmitEndedHookForRun: () => false,
    emitSubagentEndedHookForRun: vi.fn(async () => {}),
    emitSubagentProgressEndedForRun: vi.fn(async () => {}),
    notifyContextEngineSubagentEnded: vi.fn(async () => {}),
    retireSupersededRun: vi.fn(async () => {}),
    resumeSubagentRun: vi.fn(),
    callGateway: dependencies.callGateway,
    captureSubagentCompletionReply: vi.fn(async () => "final completion reply"),
    cleanupBrowserSessionsForLifecycleEnd: dependencies.cleanupBrowserSessionsForLifecycleEnd,
    runSubagentAnnounceFlow: vi.fn(async () => "delivered" as const),
    maybeWakeRequesterAfterAllChildrenSettled: vi.fn(
      async (wakeParams: {
        settledEntry: SubagentRunRecord;
        completeBatch: RequesterSettleWakeParams["completeBatch"];
      }) => {
        await wakeParams.completeBatch([wakeParams.settledEntry]);
        return false;
      },
    ),
    warn: vi.fn(),
  };
  Object.assign(params, overrides);
  const recordOwners = () => {
    for (const run of params.runs.values()) {
      dependencies.ownersByEntry.set(run, params);
    }
  };
  recordOwners();
  const wake = params.maybeWakeRequesterAfterAllChildrenSettled;
  params.maybeWakeRequesterAfterAllChildrenSettled = (request) => {
    recordOwners();
    return wake(request);
  };
  return new SubagentLifecycleController(params);
}
