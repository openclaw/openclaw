import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { prepareRequesterCronAuthority } from "../requester-cron-authority.js";
import type { SubagentLifecycleWakeContext } from "./subagent-registry-lifecycle-context.js";
import { commitRequesterInitialTransfer } from "./subagent-registry-requester-wake-commit.js";
import {
  markRequesterTurnYieldedInRuns,
  type RequesterInitialTransfer,
} from "./subagent-registry-requester-yield.js";
import { saveSubagentRegistryChangesToSqlite } from "./subagent-registry-state.fixture.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { latestSubagentRun } from "./subagent-run-generation.js";

export function createRequesterWakeContextFixture(
  runs: Map<string, SubagentRunRecord>,
  warn: SubagentLifecycleWakeContext["options"]["warn"] = () => {},
): SubagentLifecycleWakeContext {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected requester fixture effect");
  };
  return {
    options: {
      runs,
      warn,
      resumedRuns: new Set(),
      subagentAnnounceTimeoutMs: 1_000,
      getRuntimeConfig: () => ({}),
      clearPendingLifecycleError: () => {},
      countPendingDescendantRuns: async () => 0,
      getLatestRunForChildSession: (key, matches) =>
        latestSubagentRun(
          [...runs.values()].filter((entry) => entry.childSessionKey === key),
          matches,
        ) ?? null,
      suppressAnnounceForSteerRestart: () => false,
      shouldEmitEndedHookForRun: () => false,
      emitSubagentEndedHookForRun: unexpected,
      emitSubagentProgressEndedForRun: unexpected,
      notifyContextEngineSubagentEnded: unexpected,
      retireSupersededRun: unexpected,
      resumeSubagentRun: () => {},
      callGateway: unexpected,
      captureSubagentCompletionReply: unexpected,
      runSubagentAnnounceFlow: unexpected,
      maybeWakeRequesterAfterAllChildrenSettled: unexpected,
    },
    pendingRequesterSettleWakeCommits: new Map(),
    pendingRequesterSettleWakeRearms: new Set(),
    cancelledRequesterSettleWakeRuns: new Set(),
    scheduledRequesterSettleWakeRuns: new Set(),
    scheduledRequesterSettleWakeTimers: new Map(),
    newerGenerationOwnsSession: () => false,
    shouldSuppressSessionEffects: async () => false,
    sessionEffectsHostCurrent: () => true,
    getSessionEffects: () => undefined,
    resumeAncestorCleanup: () => {},
    runRequesterSettleWake: unexpected,
    unmarkRequesterSettleWakeRunScheduled: () => {},
  };
}

/** Seed SQLite, then exercise the real handoff and admitted worker mutation owners. */
export function createRequesterInitialTransferFixture(
  runs: Map<string, SubagentRunRecord>,
  beforeWrite?: (...runIds: string[]) => void,
  options: { assertCurrent?: () => void } = {},
): RequesterInitialTransfer {
  const context = createRequesterWakeContextFixture(runs);
  return async (params) => {
    saveSubagentRegistryChangesToSqlite(runs, [...runs.keys()]);
    const wrap =
      (mutate: (entries: SubagentRunRecord[]) => ReadonlySet<string> | void) =>
      (entries: SubagentRunRecord[]) => {
        const retired = mutate(entries);
        beforeWrite?.(...entries.map((entry) => entry.runId));
        return retired;
      };
    await commitRequesterInitialTransfer(context, {
      ...params,
      mutate: wrap(params.mutate),
      ...(params.release ? { release: wrap(params.release) } : {}),
      stateContext: captureOpenClawStateWorkerContext(),
      assertCurrent: options.assertCurrent ?? (() => {}),
    });
  };
}

/** Mirrors the lifecycle controller: prepare requester cron authority, mark, then release. */
export async function markRequesterTurnYieldedWithAuthority(
  params: Omit<Parameters<typeof markRequesterTurnYieldedInRuns>[0], "preparedAuthority">,
): Promise<number> {
  const preparedAuthority = prepareRequesterCronAuthority(params);
  try {
    return await markRequesterTurnYieldedInRuns({
      ...params,
      preparedAuthority: preparedAuthority ?? null,
    });
  } finally {
    await preparedAuthority?.release();
  }
}
