import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import {
  prepareTerminatedCollectorLaunch,
  prepareSwarmCollectorCompletion,
  clearPublishedSwarmCollectorOutput,
} from "../swarm/swarm-collector.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { getCurrentSubagentRunOwner } from "./subagent-registry-memory.js";
import { mutateSubagentRuns, SubagentRegistryWriteError } from "./subagent-registry-persistence.js";
import type { SubagentManagerOptions } from "./subagent-registry-run-wait.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";

export function createQueuedRegistrationSettlement(params: {
  entry: SubagentRunRecord;
  context: OpenClawStateWorkerContext;
  manager: Pick<SubagentManagerOptions, "runs" | "getRuntimeConfig">;
  assertRegistryCurrent: () => void;
  ownsSession: () => boolean;
  waitForClaim: () => Promise<void> | undefined;
  canContinueSettlement: () => boolean;
  canPrepareCancelled: () => boolean;
  setPending: (pending: boolean) => void;
  retire: () => void;
  onTerminalPublished: (execution: SubagentRunRecord["execution"]) => void;
}) {
  const { entry, context, manager, ownsSession, waitForClaim } = params;
  let cancelledLaunch:
    | { error: string; killedAt: number; failure?: Error; published?: true }
    | undefined;
  const cancellationCurrent = (current: SubagentRunRecord) =>
    ownsSession() &&
    !current.killIntent &&
    current.killReconciliation &&
    current.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
    current.execution.status === "terminal" &&
    typeof current.execution.endedAt === "number" &&
    current.swarmLaunchPending === true &&
    !current.collectorCompletion;
  const publish = async (
    stage: "recovery intent" | "terminal" | "cancelled launch",
    prepare: (current: SubagentRunRecord, ownedSession: boolean) => SubagentRunRecord,
  ): Promise<boolean> => {
    for (;;) {
      for (let claim = waitForClaim(); claim; claim = waitForClaim()) {
        await claim;
      }
      const selected = getCurrentSubagentRunOwner(manager.runs, entry);
      if (!selected) {
        return false;
      }
      const result = await mutateSubagentRuns(
        [selected.runId],
        (rows) => {
          const current = rows.get(selected.runId);
          if (!current || !isSameSubagentRunOwner(current, entry)) {
            return { value: "retired" as const };
          }
          if (stage !== "cancelled launch" && current.killReconciliation) {
            return { value: "retired" as const };
          }
          if (current.killIntent) {
            return { value: "claim" as const };
          }
          if (
            stage === "cancelled launch"
              ? !cancellationCurrent(current) ||
                current.killReconciliation?.killedAt !== cancelledLaunch?.killedAt
              : !params.canContinueSettlement()
          ) {
            return { value: "retired" as const };
          }
          return {
            value: "published" as const,
            postimages: new Map([[current.runId, prepare(current, ownsSession())]]),
          };
        },
        {
          runs: manager.runs,
          context,
          assertCurrent: params.assertRegistryCurrent,
          onPublished: (postimages) => {
            const current = postimages.get(selected.runId);
            if (current) {
              clearPublishedSwarmCollectorOutput(current);
              if (stage === "terminal") {
                params.onTerminalPublished(current.execution);
              }
            }
          },
        },
      );
      if (result !== "claim") {
        return result === "published";
      }
    }
  };
  return {
    prepareCancelled: (error: string) => {
      if (cancelledLaunch) {
        return true;
      }
      const current = getCurrentSubagentRunOwner(manager.runs, entry);
      if (
        !params.canPrepareCancelled() ||
        !current ||
        !isSameSubagentRunOwner(current, entry) ||
        !cancellationCurrent(current)
      ) {
        return false;
      }
      params.setPending(true);
      cancelledLaunch = { error, killedAt: current.killReconciliation!.killedAt };
      return true;
    },
    settleCancelled: async () => {
      const prepared = cancelledLaunch;
      if (!prepared || prepared.published) {
        return;
      }
      if (prepared.failure) {
        throw prepared.failure;
      }
      try {
        const collectorSession = await prepareSwarmCollectorCompletion(
          getCurrentSubagentRunOwner(manager.runs, entry) ?? entry,
          manager.getRuntimeConfig(),
          params.assertRegistryCurrent,
        );
        const published = await publish("cancelled launch", (current) => {
          const draft = structuredClone(current);
          prepareTerminatedCollectorLaunch(
            draft,
            current.execution.endedAt!,
            prepared.error,
            () => manager.getRuntimeConfig(),
            collectorSession,
          );
          return draft;
        });
        if (published) {
          prepared.published = true;
        } else {
          params.retire();
        }
        params.setPending(false);
      } catch (error) {
        if (
          hasSqliteWorkerOutcomeUnknown(error) ||
          (error instanceof SubagentRegistryWriteError && error.outcome === "committed")
        ) {
          prepared.failure = toErrorObject(error, "Cancelled collector launch settlement failed");
        }
        throw error;
      }
    },
    publish,
  };
}
