import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { measureStartup, type GatewayStartupTrace } from "../../../gateway/server-startup-trace.js";
import { waitForAgentDatabasePreparation } from "../../../state/agent-database-preparation-context.js";
import type { AgentRecoveryProgress } from "../../../state/agent-database-preparation-recovery.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import { resolveSubagentChildAgentId } from "./subagent-child-owner-match.js";
import type { SubagentLifecycleOptions } from "./subagent-registry-lifecycle-context.js";
import type { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import {
  getCurrentSubagentRunOwner,
  getSubagentActivationRuns,
} from "./subagent-registry-memory.js";
import { SubagentRegistryMutationRejectedError } from "./subagent-registry-persistence.js";
import { selectRequesterTurnChildren } from "./subagent-registry-requester-yield.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Isolate requester sessions while keeping each session's cohort and mailbox order intact. */
export function createRestoredRequesterActivator(config: {
  runs: Map<string, SubagentRunRecord>;
  bindGatewayOwners: (
    entries: readonly SubagentRunRecord[],
    startupTrace: GatewayStartupTrace | undefined,
    onRecovered: (entry: SubagentRunRecord) => void,
  ) => boolean | Promise<boolean>;
  settleRequesterTurn: SubagentLifecycleController["settleRequesterTurnAfterSessionSpawns"];
  retireSupersededRun: SubagentLifecycleOptions["retireSupersededRun"];
  resumeRuns: (
    entries: readonly SubagentRunRecord[],
    assertCurrent: () => void,
    startupTrace?: GatewayStartupTrace,
  ) => Promise<void>;
  recoverInterruptedRuns: (
    entries: readonly SubagentRunRecord[],
    startupTrace?: GatewayStartupTrace,
  ) => Promise<void>;
}) {
  // Repeated activation retries transfers without enqueuing restored collectors again.
  let groups: Array<{ entries: SubagentRunRecord[]; resumed: boolean }> | undefined;
  return {
    activate({
      cfg,
      stateContext,
      assertCurrent,
      startupTrace,
      alreadyActivated,
    }: {
      cfg: OpenClawConfig;
      stateContext: OpenClawStateWorkerContext;
      assertCurrent: () => void;
      startupTrace?: GatewayStartupTrace;
      alreadyActivated: boolean;
    }): AgentRecoveryProgress<{ resumeNeeded: boolean; failures: unknown[] }> {
      if (!groups || alreadyActivated) {
        const requesters = new Map<string, SubagentRunRecord[]>();
        for (const entry of getSubagentActivationRuns(config.runs)) {
          const identity = JSON.stringify([
            resolveSubagentRequesterAgentId(cfg, entry),
            entry.requesterSessionKey,
          ]);
          const entries = requesters.get(identity) ?? [];
          entries.push(entry);
          requesters.set(identity, entries);
        }
        groups = [...requesters.values()].map((entries) => ({
          entries,
          resumed: alreadyActivated,
        }));
        if (groups.length === 0) {
          groups.push({ entries: [], resumed: false });
        }
      }
      const activateGroup = async (
        group: NonNullable<typeof groups>[number],
        preparation: Promise<void>[],
      ) => {
        await Promise.all(preparation);
        assertCurrent();
        const currentEntries = () =>
          group.entries.flatMap((entry) => {
            const current = getCurrentSubagentRunOwner(config.runs, entry);
            return current ? [current] : [];
          });
        if (
          !(await measureStartup(startupTrace, "sidecars.subagent-bind", () =>
            config.bindGatewayOwners(currentEntries(), startupTrace, (entry) => {
              const index = group.entries.findIndex((snapshot) => snapshot.runId === entry.runId);
              if (index >= 0) {
                group.entries[index] = entry;
              }
            }),
          ))
        ) {
          assertCurrent();
          return;
        }
        if (alreadyActivated) {
          return;
        }
        const failures = await measureStartup(
          startupTrace,
          "sidecars.subagent-requesters",
          async (): Promise<unknown[]> => {
            const runs = config.runs;
            const entries = currentEntries();
            const { settleRequesterTurn, retireSupersededRun } = config;
            // Reconstruct requester claims without owning retries or altering failed cohort custody.
            const requesterTurns = new Map<string, SubagentRunRecord>();
            const resolveRequesterAgentId = (entry: SubagentRunRecord) =>
              resolveSubagentRequesterAgentId(cfg, entry);
            for (const entry of entries) {
              const requesterTurnRunId = entry.requesterTurnRunId?.trim();
              if (!requesterTurnRunId || entry.expectsCompletionMessage !== true) {
                continue;
              }
              const identity = JSON.stringify([
                resolveRequesterAgentId(entry),
                entry.requesterSessionKey,
                requesterTurnRunId,
              ]);
              requesterTurns.set(identity, requesterTurns.get(identity) ?? entry);
            }
            const transferFailures: unknown[] = [];
            for (const firstEntry of requesterTurns.values()) {
              assertCurrent();
              const requesterAgentId = resolveRequesterAgentId(firstEntry);
              const requesterTurnRunId = firstEntry.requesterTurnRunId!;
              try {
                const superseded: SubagentRunRecord[] = [];
                const selectEntries = (onSuperseded: (entry: SubagentRunRecord) => void) =>
                  selectRequesterTurnChildren(
                    runs,
                    firstEntry.requesterSessionKey,
                    requesterAgentId,
                    requesterTurnRunId,
                    onSuperseded,
                  );
                let children = selectEntries((entry) => superseded.push(entry));
                for (const entry of superseded) {
                  await retireSupersededRun(entry.runId, entry, assertCurrent);
                  assertCurrent();
                  if (runs.has(entry.runId)) {
                    throw new SubagentRegistryMutationRejectedError(
                      "Superseded requester claim changed during retirement",
                    );
                  }
                }
                if (superseded.length > 0) {
                  // Retirement can yield to another claim; select its surviving members afresh.
                  children = selectEntries(() => {
                    throw new SubagentRegistryMutationRejectedError("Restored cohort changed");
                  });
                }
                if (children.length === 0) {
                  continue;
                }
                await settleRequesterTurn(
                  {
                    requesterSessionKey: firstEntry.requesterSessionKey,
                    stateContext,
                    assertCurrent,
                    requesterAgentId,
                    requesterTurnRunId,
                    requesterYielded: children.every(
                      (entry) => entry.requesterTurnYielded === true,
                    ),
                    acceptedSessionSpawns: children.map((entry) => ({
                      runId: entry.taskRunId ?? entry.runId,
                      childSessionKey: entry.childSessionKey,
                    })),
                  },
                  "restore",
                );
              } catch (error) {
                // Failed or uncertain custody stays with its transfer owner, not with
                // unrelated cohorts or ordinary restored run activation.
                transferFailures.push(error);
              }
              assertCurrent();
            }
            return transferFailures;
          },
        );
        assertCurrent();
        if (!group.resumed) {
          await measureStartup(startupTrace, "sidecars.subagent-resume", () =>
            config.resumeRuns(currentEntries(), assertCurrent, startupTrace),
          );
          assertCurrent();
          // Source custody and ordered reservations are ready; the sweeper owns orphan settlement.
          void config.recoverInterruptedRuns(currentEntries(), startupTrace);
          group.resumed = true;
        }
        if (failures.length > 0) {
          throw failures[0];
        }
      };
      const resumeNeeded = groups.some((group) => !group.resumed);
      const preparations = groups.map((group) => {
        const agentIds = new Set(
          group.entries
            .flatMap((entry) => [
              resolveSubagentRequesterAgentId(cfg, entry),
              resolveSubagentChildAgentId(entry),
            ])
            .filter((agentId): agentId is string => Boolean(agentId)),
        );
        const preparation = [...agentIds].flatMap((agentId) => {
          const wait = waitForAgentDatabasePreparation(agentId);
          return wait ? [wait] : [];
        });
        return { group, agentIds, preparation };
      });
      const initialGroups: Promise<void>[] = [];
      const pendingGroups = new Map<string, Promise<void>[]>();
      const activation = preparations.map(({ group, agentIds, preparation }) => {
        const operation = activateGroup(group, preparation);
        if (preparation.length === 0) {
          initialGroups.push(operation);
        } else {
          // A requester and every child share the group's restored mailbox custody.
          for (const agentId of agentIds) {
            const pending = pendingGroups.get(agentId) ?? [];
            pending.push(operation);
            pendingGroups.set(agentId, pending);
          }
        }
        return operation;
      });
      const initial = Promise.all(initialGroups).then(() => undefined);
      const pending = new Map(
        [...pendingGroups].map(([agentId, operations]) => [
          agentId,
          Promise.all(operations).then(() => undefined),
        ]),
      );
      // Full-settlement callers may ignore progress while the original failure stays observable.
      void initial.catch(() => {});
      for (const operation of pending.values()) {
        void operation.catch(() => {});
      }
      const settled = Promise.allSettled(activation).then((results) => ({
        resumeNeeded,
        failures: results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        ),
      }));
      return { initial, pending, settled };
    },
    reset() {
      groups = undefined;
    },
  };
}
