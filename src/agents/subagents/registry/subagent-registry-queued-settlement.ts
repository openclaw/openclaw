import { isDeepStrictEqual } from "node:util";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { prepareTerminatedCollectorLaunch } from "../swarm/swarm-collector.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { SubagentRegistryWriteError } from "./subagent-registry-persistence.js";
import type { SubagentManagerOptions } from "./subagent-registry-run-wait.js";
import { onSubagentRegistryPersisted } from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function createQueuedRegistrationSettlement(params: {
  entry: SubagentRunRecord;
  context: OpenClawStateWorkerContext;
  manager: Pick<SubagentManagerOptions, "persistAsyncOrThrow" | "getRuntimeConfig">;
  assertRegistryCurrent: () => void;
  registryCurrent: () => boolean;
  exactEntry: () => boolean;
  ownsSession: () => boolean;
  waitForClaim: () => Promise<void> | undefined;
  pendingClaim: () => boolean;
  confirmedTakeover: () => boolean;
  canContinueSettlement: () => boolean;
  canPrepareCancelled: () => boolean;
  setPending: (pending: boolean) => void;
  retire: () => void;
  onTerminalPublished: (execution: SubagentRunRecord["execution"]) => void;
}) {
  const {
    entry,
    context,
    manager,
    assertRegistryCurrent,
    registryCurrent,
    exactEntry,
    ownsSession,
    waitForClaim,
    pendingClaim,
    confirmedTakeover,
    canContinueSettlement,
  } = params;
  const runId = entry.runId;
  let cancelledLaunch:
    | ({ preimage: SubagentRunRecord; record: SubagentRunRecord } & (
        | { phase: "prepared" | "published" }
        | { phase: "failed"; error: unknown }
      ))
    | undefined;
  const replaceEntry = (record: SubagentRunRecord) => {
    for (const key of Object.keys(entry)) {
      Reflect.deleteProperty(entry, key);
    }
    Object.assign(entry, record);
  };
  const prepareCancelledLaunch = (launchError: string) => {
    const endedAt = entry.execution.endedAt;
    if (
      !params.canPrepareCancelled() ||
      !ownsSession() ||
      entry.killIntent ||
      !entry.killReconciliation ||
      entry.endedReason !== SUBAGENT_ENDED_REASON_KILLED ||
      entry.execution.status !== "terminal" ||
      typeof endedAt !== "number" ||
      entry.swarmLaunchPending !== true ||
      entry.collectorCompletion
    ) {
      return false;
    }
    params.setPending(true);
    const prepared = {
      preimage: structuredClone(entry),
      record: structuredClone(entry),
    };
    try {
      prepareTerminatedCollectorLaunch(prepared.record, endedAt, launchError, () =>
        manager.getRuntimeConfig(),
      );
      cancelledLaunch = { ...prepared, phase: "prepared" };
    } catch (error) {
      cancelledLaunch = { ...prepared, phase: "failed", error };
      throw error;
    }
    return true;
  };
  const canContinueCancelledLaunch = () =>
    cancelledLaunch?.phase === "prepared" &&
    registryCurrent() &&
    exactEntry() &&
    ownsSession() &&
    !entry.killIntent &&
    isDeepStrictEqual(entry, cancelledLaunch.preimage);
  const publishSettlement = async (
    stage: "recovery intent" | "terminal" | "cancelled launch",
    prepare: (ownedSession: boolean) => SubagentRunRecord,
  ): Promise<boolean> => {
    const cancellation = stage === "cancelled launch";
    const canContinue = cancellation ? canContinueCancelledLaunch : canContinueSettlement;
    const claimsCurrent = () => !entry.killIntent && (cancellation || !entry.killReconciliation);
    for (;;) {
      for (let claim = waitForClaim(); claim; claim = waitForClaim()) {
        await claim;
      }
      if (!canContinue()) {
        return false;
      }
      const previous = { ...entry };
      const previousSnapshot = structuredClone(entry);
      const ownedSession = ownsSession();
      const staged = prepare(ownedSession);
      const stagedSnapshot = structuredClone(staged);
      const hasPreimage = () =>
        exactEntry() &&
        entry.execution === previous.execution &&
        isDeepStrictEqual(entry, previousSnapshot);
      let capturing = true;
      let published = false;
      let observedClaim = false;
      const stopObservingClaim = onSubagentRegistryPersisted(() => {
        if (exactEntry() && entry.killIntent) {
          observedClaim = true;
        }
      });
      try {
        let publication: Promise<void>;
        replaceEntry(staged);
        try {
          publication = manager.persistAsyncOrThrow(
            context,
            {
              assertCurrent: () => {
                assertRegistryCurrent();
                if (
                  !claimsCurrent() ||
                  ownsSession() !== ownedSession ||
                  !(capturing
                    ? exactEntry() &&
                      entry.execution === staged.execution &&
                      isDeepStrictEqual(entry, stagedSnapshot)
                    : hasPreimage())
                ) {
                  throw new Error(`Queued registration ${stage} lost its original owner`);
                }
              },
              onCommitted: () => {
                if (
                  registryCurrent() &&
                  claimsCurrent() &&
                  hasPreimage() &&
                  ownsSession() === ownedSession
                ) {
                  replaceEntry(staged);
                  if (stage === "terminal") {
                    params.onTerminalPublished(entry.execution);
                  }
                  published = true;
                }
              },
            },
            runId,
          );
        } finally {
          if (
            exactEntry() &&
            entry.execution === staged.execution &&
            isDeepStrictEqual(entry, stagedSnapshot)
          ) {
            replaceEntry(previous);
          }
          capturing = false;
        }
        await publication;
      } catch (error) {
        if (
          !cancellation &&
          error instanceof SubagentRegistryWriteError &&
          error.outcome === "not-committed" &&
          registryCurrent() &&
          exactEntry() &&
          (observedClaim || pendingClaim() || confirmedTakeover())
        ) {
          continue;
        }
        throw error;
      } finally {
        stopObservingClaim();
      }
      if (published) {
        return true;
      }
      if (!canContinue()) {
        return false;
      }
      if (observedClaim || pendingClaim() || ownsSession() !== ownedSession) {
        // A known ACK can lose publication to a committed claim/release or new session owner.
        continue;
      }
      throw new Error(`Queued registration ${stage} publication was superseded`);
    }
  };
  const settleCancelledLaunch = async () => {
    const prepared = cancelledLaunch;
    if (!prepared || prepared.phase === "published") {
      return;
    }
    if (prepared.phase === "failed") {
      throw prepared.error;
    }
    try {
      const published = await publishSettlement("cancelled launch", () => prepared.record);
      if (published) {
        cancelledLaunch = { ...prepared, phase: "published" };
      } else {
        params.retire();
      }
      params.setPending(false);
    } catch (error) {
      if (!(error instanceof SubagentRegistryWriteError && error.outcome === "not-committed")) {
        cancelledLaunch = { ...prepared, phase: "failed", error };
      }
      throw error;
    }
  };
  return {
    prepareCancelled: (error: string) =>
      cancelledLaunch !== undefined || prepareCancelledLaunch(error),
    settleCancelled: settleCancelledLaunch,
    publish: publishSettlement,
  };
}
