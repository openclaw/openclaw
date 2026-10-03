import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import {
  planAgentSteeringAcknowledgment,
  preparePendingAgentSteeringLease,
  planAgentSteeringRelease,
} from "../../agent-steering-queue.js";
import { captureGatewayToolCallerAssertion } from "../../tools/gateway-caller-context.js";
import { prepareRequesterCronAuthority } from "../requester-cron-authority.js";
import type { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import { getSubagentRunsForChildSession } from "./subagent-registry-memory.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  mutateSubagentRuns,
  SubagentRegistryMutationRejectedError,
  SubagentRegistryWriteError,
} from "./subagent-registry-persistence.js";
import {
  countActiveRunsForSessionFromRuns,
  listSwarmRunsForGroupFromRuns,
  getLatestSubagentRunByChildSessionKeyFromRuns,
} from "./subagent-registry-queries.js";
import type { PreparedSubagentRunsRead } from "./subagent-registry-read-snapshot.js";
import { listUnsettledRequesterChildrenInRuns } from "./subagent-registry-requester-yield.js";
import { markSubagentMessageWaitInRuns } from "./subagent-registry-run-pause.js";
import {
  getSubagentRunsSnapshotForRead,
  prepareSubagentRunsSnapshotForRunIds,
} from "./subagent-registry-state.js";
import type { SubagentRunRecord, SwarmStructuredOutputState } from "./subagent-registry.types.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";

export function createSubagentRegistryPublicApi(config: {
  runs: Map<string, SubagentRunRecord>;
  restoreOnce: (context?: OpenClawStateWorkerContext) => Promise<void>;
  startAnnounceCleanup: (runId: string, entry: SubagentRunRecord) => boolean;
  settleRequesterTurn: SubagentLifecycleController["settleRequesterTurnAfterSessionSpawns"];
  markRequesterYielded: SubagentLifecycleController["markRequesterTurnYielded"];
}) {
  const { runs, restoreOnce, startAnnounceCleanup, settleRequesterTurn } = config;
  const readRuns = () => getSubagentRunsSnapshotForRead(runs);
  const findRunById = (records: Map<string, SubagentRunRecord>, runId: string) =>
    records.get(runId) ?? [...records.values()].find((entry) => entry.swarmRunId === runId);

  async function leasePendingAgentSteeringItems(params: {
    requesterSessionKey: string;
    leaseId: string;
    now?: number;
  }) {
    const context = captureOpenClawStateWorkerContext();
    await restoreOnce(context);
    const prepared = await preparePendingAgentSteeringLease({
      ...params,
      runs,
      readResult: async (entry) => {
        const { readSubagentRunAnnounceResult } =
          await import("../announce/subagent-announce-output.js");
        return readSubagentRunAnnounceResult(entry, (runId) => runs.get(runId));
      },
    });
    if (!prepared) {
      return undefined;
    }
    const assertCurrent = () => {
      if (!prepared.isCurrent()) {
        throw new SubagentRegistryMutationRejectedError(
          "A queued child result changed while preparing the requester prompt.",
        );
      }
    };
    return mutateSubagentRuns(
      prepared.runIds,
      (rows) => {
        const planned = prepared.plan(rows);
        if (!planned) {
          throw new SubagentRegistryMutationRejectedError(
            "A queued child result is no longer available for requester steering.",
          );
        }
        return planned;
      },
      { runs, context, assertCurrent },
    );
  }

  function ackPendingAgentSteeringItems(params: {
    runIds: readonly string[];
    leaseId: string;
    now?: number;
  }): Promise<number> {
    return mutateSubagentRuns(
      params.runIds,
      (rows) => planAgentSteeringAcknowledgment({ ...params, runs: rows }),
      {
        runs,
        onPublished: (postimages) => {
          for (const [runId, entry] of postimages) {
            if (entry && typeof entry.cleanupCompletedAt !== "number") {
              startAnnounceCleanup(runId, entry);
            }
          }
        },
      },
    );
  }

  function releasePendingAgentSteeringItems(params: {
    runIds: readonly string[];
    leaseId: string;
    error?: string;
  }): Promise<number> {
    return mutateSubagentRuns(
      params.runIds,
      (rows) => planAgentSteeringRelease({ ...params, runs: rows }),
      { runs },
    );
  }

  function getSubagentRunByRunId(runId: string): SubagentRunRecord | undefined {
    return findRunById(readRuns(), runId.trim());
  }

  async function prepareSubagentRunsByRunIds(
    runIds: readonly string[],
  ): Promise<PreparedSubagentRunsRead> {
    // Waiters need only their targets; retained results must not expand every wake's maps.
    const prepared = await prepareSubagentRunsSnapshotForRunIds(runs, runIds);
    return {
      consume(consume) {
        return prepared.consume((selected) => {
          const byId = new Map<string, SubagentRunRecord>();
          for (const entry of selected.values()) {
            byId.set(entry.runId, entry);
            if (entry.swarmRunId) {
              byId.set(entry.swarmRunId, entry);
            }
          }
          return consume(
            new Map(
              runIds.flatMap((runId) => {
                const entry = byId.get(runId.trim());
                return entry ? [[runId, entry] as const] : [];
              }),
            ),
          );
        });
      },
    };
  }

  async function completeCollectorLaunchCleanup(runId: string): Promise<void> {
    const expected = findRunById(runs, runId.trim());
    if (!expected) {
      return;
    }
    await mutateSubagentRuns(
      [expected.runId],
      (rows) => {
        const entry = rows.get(expected.runId);
        if (
          !entry ||
          !isSameSubagentRunOwner(entry, expected) ||
          !entry.collectorLaunchCleanupPending
        ) {
          return { value: undefined };
        }
        const completedAt = Date.now();
        return {
          value: undefined,
          postimages: new Map([
            [
              entry.runId,
              {
                ...entry,
                collectorLaunchCleanupPending: false,
                cleanupCompletedAt: completedAt,
                contextEngineCleanupCompletedAt:
                  entry.contextEngineCleanupCompletedAt ?? completedAt,
              },
            ],
          ]),
        };
      },
      { runs },
    );
  }

  async function recordSwarmStructuredOutput(
    identity: { runId?: string; childSessionKey?: string; childAgentId?: string },
    state: SwarmStructuredOutputState,
    assertCurrent?: () => void,
  ): Promise<void> {
    const runId = identity.runId?.trim();
    const childSessionKey = identity.childSessionKey?.trim();
    const entry =
      (runId ? findRunById(runs, runId) : undefined) ??
      (childSessionKey
        ? getLatestSubagentRunByChildSessionKeyFromRuns(
            getSubagentRunsForChildSession(childSessionKey, identity.childAgentId),
            childSessionKey,
            undefined,
            identity.childAgentId,
          )
        : undefined);
    if (!entry?.collect || entry.collectorCompletion) {
      throw new Error("collector run is unavailable");
    }
    const next = structuredClone(state);
    await mutateSubagentRuns(
      [entry.runId],
      (rows) => {
        const current = rows.get(entry.runId);
        if (
          !current?.collect ||
          !isSameSubagentRunOwner(current, entry) ||
          current.collectorCompletion
        ) {
          throw new SubagentRegistryMutationRejectedError("collector run is unavailable");
        }
        if (
          current.structuredOutput?.structured !== undefined ||
          (current.structuredOutput?.invalidAttempts ?? 0) >= 2 ||
          (next.structured === undefined &&
            next.invalidAttempts !== (current.structuredOutput?.invalidAttempts ?? 0) + 1)
        ) {
          throw new SubagentRegistryMutationRejectedError(
            "collector output changed before publication",
          );
        }
        return {
          value: undefined,
          postimages: new Map([[current.runId, { ...current, structuredOutput: next }]]),
        };
      },
      { runs, assertCurrent },
    );
  }

  function listSwarmRunsForGroup(
    groupId: string,
    requesterSessionKey?: string,
    requesterAgentId?: string,
  ): SubagentRunRecord[] {
    return listSwarmRunsForGroupFromRuns(
      readRuns(),
      groupId,
      requesterSessionKey,
      requesterAgentId,
    );
  }

  /** Resolve a collector reserved by a replay-safe host bridge request. */
  function getSwarmRunByLaunchReplayKey(
    replayKey: string,
    requesterSessionKey?: string,
    requesterAgentId?: string,
  ): SubagentRunRecord | undefined {
    const key = replayKey.trim();
    const requesterKey = requesterSessionKey?.trim();
    if (!key) {
      return undefined;
    }
    return [...readRuns().values()].find(
      (entry) =>
        entry.collect === true &&
        entry.swarmLaunchReplayKey === key &&
        (!requesterKey ||
          (entry.swarmRequesterSessionKey ?? entry.requesterSessionKey) === requesterKey) &&
        (!requesterAgentId || entry.requesterAgentId === requesterAgentId),
    );
  }

  function countActiveRunsForSession(
    requesterSessionKey: string,
    options?: { collect?: boolean; requesterAgentId?: string },
  ): number {
    return countActiveRunsForSessionFromRuns(readRuns(), requesterSessionKey, options);
  }

  /** Records sessions_yield before the active requester run is aborted. */
  async function markRequesterTurnYielded(
    params: Parameters<SubagentLifecycleController["markRequesterTurnYielded"]>[0],
  ): Promise<number> {
    const stateContext = params.stateContext ?? captureOpenClawStateWorkerContext();
    const assertCallerCurrent = captureGatewayToolCallerAssertion();
    const assertCurrent = () => {
      assertSubagentRegistryWriteSourceCurrent(stateContext);
      assertCallerCurrent?.();
      params.assertCurrent?.();
    };
    assertCurrent();
    const preparedAuthority = prepareRequesterCronAuthority(params) ?? null;
    let result: number;
    try {
      await restoreOnce(stateContext);
      result = await config.markRequesterYielded({
        ...params,
        stateContext,
        assertCurrent,
        preparedAuthority,
      });
      try {
        assertCurrent();
        if (result > 0) {
          preparedAuthority?.assertCurrent();
        }
      } catch (error) {
        throw new SubagentRegistryWriteError(
          result > 0 ? "committed" : "not-committed",
          error,
          result > 0 ? "published" : undefined,
        );
      }
    } finally {
      const release = preparedAuthority?.release();
      if (release) {
        await release;
      }
    }
    try {
      assertCurrent();
    } catch (error) {
      throw new SubagentRegistryWriteError(
        result > 0 ? "committed" : "not-committed",
        error,
        result > 0 ? "published" : undefined,
      );
    }
    return result;
  }

  /** Lists announcing children whose completion this requester session still awaits. */
  async function listUnsettledRequesterChildren(params: {
    requesterSessionKey: string;
    requesterAgentId?: string;
    excludeRequesterTurnRunId?: string;
  }) {
    await restoreOnce();
    // Same live-map view as the yield claim: rows this turn just registered
    // count, and rows the registry already retired do not.
    return listUnsettledRequesterChildrenInRuns({ ...params, runs });
  }

  return {
    markSubagentMessageWait: async (params: {
      runId: string;
      sessionKey: string;
      acknowledgment?: string;
    }) => {
      const stateContext = captureOpenClawStateWorkerContext();
      const assertCallerCurrent = captureGatewayToolCallerAssertion();
      const assertCurrent = () => {
        assertSubagentRegistryWriteSourceCurrent(stateContext);
        assertCallerCurrent?.();
      };
      assertCurrent();
      await restoreOnce(stateContext);
      return await markSubagentMessageWaitInRuns({
        ...params,
        runs,
        context: stateContext,
        assertCurrent,
      });
    },
    leasePendingAgentSteeringItems,
    ackPendingAgentSteeringItems,
    releasePendingAgentSteeringItems,
    getSubagentRunByRunId,
    prepareSubagentRunsByRunIds,
    completeCollectorLaunchCleanup,
    recordSwarmStructuredOutput,
    listSwarmRunsForGroup,
    getSwarmRunByLaunchReplayKey,
    countActiveRunsForSession,
    settleRequesterAfterSessionSpawns: settleRequesterTurn,
    markRequesterTurnYielded,
    listUnsettledRequesterChildren,
  };
}
