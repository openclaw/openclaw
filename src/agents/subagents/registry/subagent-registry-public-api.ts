import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { prepareRequesterCronAuthority } from "../requester-cron-authority.js";
import { resolveRecordedRequester } from "./subagent-child-owner-match.js";
import type { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import { getSubagentRunsForChildSession } from "./subagent-registry-memory.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  mutateSubagentRuns,
  SubagentRegistryMutationRejectedError,
  SubagentRegistryWriteError,
} from "./subagent-registry-persistence.js";
import {
  listSwarmRunsForGroupFromRuns,
  getLatestSubagentRunByChildSessionKeyFromRuns,
  buildLatestSubagentRunReadIndexFromRuns,
  listRunsForRequesterFromRuns,
} from "./subagent-registry-queries.js";
import type { PreparedSubagentRunsRead } from "./subagent-registry-read-snapshot.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import { listUnsettledRequesterChildrenInRuns } from "./subagent-registry-requester-yield.js";
import { claimSubagentYieldInRuns } from "./subagent-registry-run-pause.js";
import {
  countActiveSubagentRunsForSession,
  getSubagentRunsSnapshotForRead,
  getSubagentSessionListRunsSnapshotForRead,
  withSubagentRunReadSnapshot,
  prepareSubagentRunsSnapshotForRunIds,
} from "./subagent-registry-state.js";
import type { SubagentRunRecord, SwarmStructuredOutputState } from "./subagent-registry.types.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";
import { isSubagentRunQueued } from "./subagent-run-liveness.js";

export function createSubagentRegistryPublicApi(config: {
  runs: Map<string, SubagentRunRecord>;
  restoreOnce: (context?: OpenClawStateWorkerContext) => Promise<void>;
  settleRequesterTurn: SubagentLifecycleController["settleRequesterTurnAfterSessionSpawns"];
  markRequesterYielded: SubagentLifecycleController["markRequesterTurnYielded"];
}) {
  const { runs, restoreOnce, settleRequesterTurn } = config;
  const readRuns = () => getSubagentRunsSnapshotForRead(runs);
  const findRunById = (records: Map<string, SubagentRunRecord>, runId: string) =>
    records.get(runId) ?? [...records.values()].find((entry) => entry.swarmRunId === runId);

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
          (state.structured === undefined &&
            state.invalidAttempts !== (current.structuredOutput?.invalidAttempts ?? 0) + 1)
        ) {
          throw new SubagentRegistryMutationRejectedError(
            "collector output changed before publication",
          );
        }
        return {
          value: undefined,
          postimages: new Map([[current.runId, { ...current, structuredOutput: state }]]),
        };
      },
      { runs, assertCurrent },
    );
  }

  function listSwarmRunsForGroup(
    groupId: string,
    requesterSessionKey?: string,
    requesterAgentId?: string,
  ): SubagentRunReadRecord[] {
    return listSwarmRunsForGroupFromRuns(
      getSubagentSessionListRunsSnapshotForRead(runs),
      groupId,
      requesterSessionKey,
      requesterAgentId,
    );
  }

  /** Read current direct-child collectors of a requester chat. */
  async function listCollectorRunsForRequester(params: {
    sessionKey: string;
    agentId: string;
  }): Promise<SubagentRunRecord[]> {
    return withSubagentRunReadSnapshot(
      runs,
      (snapshot) => {
        const latest = buildLatestSubagentRunReadIndexFromRuns(snapshot);
        return {
          runIds: [...snapshot.values()]
            .filter(
              (entry) =>
                entry.collect === true &&
                entry.requesterSessionKey === params.sessionKey &&
                latest.getLatestSubagentRun(entry.childSessionKey, entry.childAgentId) === entry,
            )
            .map((entry) => entry.runId),
          sessionKeys: [],
        };
      },
      (_selection, selected) =>
        listRunsForRequesterFromRuns(new Map(selected), params.sessionKey, {
          requesterAgentId: params.agentId,
        }),
      "all",
    );
  }

  /** Resolve replay eligibility without exposing the collector's retained state. */
  async function resolveSwarmLaunchReplay(
    replayKey: string,
    requestFingerprint: string,
    requesterSessionKey?: string,
    requesterAgentId?: string,
  ) {
    const key = replayKey.trim();
    const requesterKey = requesterSessionKey?.trim();
    if (!key) {
      return { status: "missing" } as const;
    }
    return withSubagentRunReadSnapshot(
      runs,
      (snapshot) => ({
        runIds: [...snapshot.values()]
          .filter(
            (entry) =>
              entry.collect === true &&
              entry.swarmLaunchReplayKey === key &&
              (!requesterKey ||
                (entry.swarmRequesterSessionKey ?? entry.requesterSessionKey) === requesterKey) &&
              (!requesterAgentId || resolveRecordedRequester(entry) === requesterAgentId),
          )
          .map((entry) => entry.runId),
        sessionKeys: [],
      }),
      (_selection, selected) => {
        const entry = selected.values().next().value;
        if (!entry) {
          return { status: "missing" } as const;
        }
        if (entry.swarmLaunchRequestFingerprint !== requestFingerprint) {
          return { status: "mismatch" } as const;
        }
        if (entry.swarmLaunchPending && !isSubagentRunQueued(entry)) {
          return { status: "inactive" } as const;
        }
        return {
          status: "accepted" as const,
          runId: entry.swarmRunId ?? entry.runId,
          currentRunId: entry.runId,
          childSessionKey: entry.childSessionKey,
          ...(entry.label ? { label: entry.label } : {}),
        };
      },
      "all",
    );
  }

  /** Records sessions_yield before the active requester run is aborted. */
  async function markRequesterTurnYielded(
    params: Parameters<SubagentLifecycleController["markRequesterTurnYielded"]>[0],
  ): Promise<number> {
    const stateContext = params.stateContext ?? captureOpenClawStateWorkerContext();
    const assertCurrent = () => {
      assertSubagentRegistryWriteSourceCurrent(stateContext);
      params.assertCurrent?.();
    };
    assertCurrent();
    const preparedAuthority = prepareRequesterCronAuthority(params) ?? null;
    let result: number;
    const assertPublishedCurrent = (checkAuthority: boolean) => {
      try {
        assertCurrent();
        if (checkAuthority && result > 0) {
          preparedAuthority?.assertCurrent();
        }
      } catch (error) {
        throw new SubagentRegistryWriteError(
          result > 0 ? "committed" : "not-committed",
          error,
          result > 0 ? "published" : undefined,
        );
      }
    };
    try {
      await restoreOnce(stateContext);
      result = await config.markRequesterYielded({
        ...params,
        stateContext,
        assertCurrent,
        preparedAuthority,
      });
      assertPublishedCurrent(true);
    } finally {
      const release = preparedAuthority?.release();
      if (release) {
        await release;
      }
    }
    assertPublishedCurrent(false);
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
    claimSubagentYield: async (params: {
      runId: string;
      sessionKey: string;
      agentId: string;
      waitForMessage: boolean;
      hasPendingWork: () => boolean;
      acknowledgment?: string;
    }) => {
      const stateContext = captureOpenClawStateWorkerContext();
      const assertCurrent = () => assertSubagentRegistryWriteSourceCurrent(stateContext);
      assertCurrent();
      await restoreOnce(stateContext);
      return await claimSubagentYieldInRuns({
        ...params,
        runs,
        context: stateContext,
        assertCurrent,
      });
    },
    getSubagentRunByRunId,
    prepareSubagentRunsByRunIds,
    completeCollectorLaunchCleanup,
    recordSwarmStructuredOutput,
    listSwarmRunsForGroup,
    resolveSwarmLaunchReplay,
    listCollectorRunsForRequester,
    countActiveRunsForSession: countActiveSubagentRunsForSession.bind(null, runs),
    settleRequesterAfterSessionSpawns: settleRequesterTurn,
    markRequesterTurnYielded,
    listUnsettledRequesterChildren,
  };
}
