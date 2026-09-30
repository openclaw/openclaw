import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import {
  ackLeasedAgentSteeringItemsFromSubagentRuns,
  leasePendingAgentSteeringItemsFromSubagentRuns,
  releaseLeasedAgentSteeringItemsFromSubagentRuns,
} from "../../agent-steering-queue.js";
import { captureGatewayToolCallerAssertion } from "../../tools/gateway-caller-context.js";
import { prepareRequesterCronAuthority } from "../requester-cron-authority.js";
import type { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import { getSubagentRunsForChildSession } from "./subagent-registry-memory.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  SubagentRegistryWriteError,
} from "./subagent-registry-persistence.js";
import {
  countActiveRunsForSessionFromRuns,
  listSwarmRunsForGroupFromRuns,
  getLatestSubagentRunByChildSessionKeyFromRuns,
} from "./subagent-registry-queries.js";
import type { PreparedSubagentRunsRead } from "./subagent-registry-read-snapshot.js";
import { listUnsettledRequesterChildrenInRuns } from "./subagent-registry-requester-yield.js";
import { claimSubagentYieldInRuns } from "./subagent-registry-run-pause.js";
import {
  getSubagentRunsSnapshotForRead,
  prepareSubagentRunsSnapshotForRunIds,
} from "./subagent-registry-state.js";
import type { SubagentRunRecord, SwarmStructuredOutputState } from "./subagent-registry.types.js";

export function createSubagentRegistryPublicApi(config: {
  runs: Map<string, SubagentRunRecord>;
  persist: (...runIds: string[]) => void;
  persistOrThrow: (...runIds: string[]) => void;
  persistAsyncOrThrow: Parameters<typeof claimSubagentYieldInRuns>[0]["persist"];
  restoreOnce: (context?: OpenClawStateWorkerContext) => Promise<void>;
  startAnnounceCleanup: (runId: string, entry: SubagentRunRecord) => boolean;
  settleRequesterTurn: SubagentLifecycleController["settleRequesterTurnAfterSessionSpawns"];
  markRequesterYielded: SubagentLifecycleController["markRequesterTurnYielded"];
}) {
  const { runs, persist, persistOrThrow, restoreOnce, startAnnounceCleanup, settleRequesterTurn } =
    config;
  const readRuns = () => getSubagentRunsSnapshotForRead(runs);
  const findRunById = (records: Map<string, SubagentRunRecord>, runId: string) =>
    records.get(runId) ?? [...records.values()].find((entry) => entry.swarmRunId === runId);

  async function leasePendingAgentSteeringItems(params: {
    requesterSessionKey: string;
    leaseId: string;
    now?: number;
  }) {
    await restoreOnce();
    const leased = await leasePendingAgentSteeringItemsFromSubagentRuns({
      ...params,
      runs,
      readResult: async (entry) => {
        const { readSubagentRunAnnounceResult } =
          await import("../announce/subagent-announce-output.js");
        return readSubagentRunAnnounceResult(entry);
      },
    });
    if (leased) {
      persist(...leased.runIds);
    }
    return leased;
  }

  function ackPendingAgentSteeringItems(params: {
    runIds: readonly string[];
    leaseId: string;
    now?: number;
  }): number {
    const updated = ackLeasedAgentSteeringItemsFromSubagentRuns({ ...params, runs });
    if (updated > 0) {
      persist(...params.runIds);
      for (const runId of params.runIds) {
        const entry = runs.get(runId);
        if (!entry || typeof entry.cleanupCompletedAt === "number") {
          continue;
        }
        entry.cleanupHandled = false;
        startAnnounceCleanup(runId, entry);
      }
    }
    return updated;
  }

  function releasePendingAgentSteeringItems(params: {
    runIds: readonly string[];
    leaseId: string;
    error?: string;
  }): number {
    const updated = releaseLeasedAgentSteeringItemsFromSubagentRuns({ ...params, runs });
    if (updated > 0) {
      persist(...params.runIds);
    }
    return updated;
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

  function completeCollectorLaunchCleanup(runId: string): void {
    const entry = findRunById(runs, runId.trim());
    if (!entry?.collectorLaunchCleanupPending) {
      return;
    }
    entry.collectorLaunchCleanupPending = false;
    entry.cleanupCompletedAt = Date.now();
    entry.contextEngineCleanupCompletedAt ??= entry.cleanupCompletedAt;
    persist(entry.runId);
  }

  function recordSwarmStructuredOutput(
    identity: { runId?: string; childSessionKey?: string },
    state: SwarmStructuredOutputState,
  ): void {
    const runId = identity.runId?.trim();
    const childSessionKey = identity.childSessionKey?.trim();
    const entry =
      (runId ? findRunById(runs, runId) : undefined) ??
      (childSessionKey
        ? getLatestSubagentRunByChildSessionKeyFromRuns(
            getSubagentRunsForChildSession(childSessionKey),
            childSessionKey,
          )
        : undefined);
    if (!entry?.collect || entry.collectorCompletion) {
      throw new Error("collector run is unavailable");
    }
    const previous = entry.structuredOutput;
    entry.structuredOutput = structuredClone(state);
    try {
      persistOrThrow(entry.runId);
    } catch (error) {
      entry.structuredOutput = previous;
      throw error;
    }
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
    claimSubagentYield: async (params: {
      runId: string;
      sessionKey: string;
      acknowledgment?: string;
      waitForMessage: boolean;
      hasPendingWork: () => boolean;
    }) => {
      const stateContext = captureOpenClawStateWorkerContext();
      const assertCallerCurrent = captureGatewayToolCallerAssertion();
      const assertCurrent = () => {
        assertSubagentRegistryWriteSourceCurrent(stateContext);
        assertCallerCurrent?.();
      };
      assertCurrent();
      await restoreOnce(stateContext);
      return await claimSubagentYieldInRuns({
        ...params,
        runs,
        context: stateContext,
        assertCurrent,
        persist: config.persistAsyncOrThrow,
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
