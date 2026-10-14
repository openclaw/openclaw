import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import type { SubagentLifecycleOptions } from "./subagent-registry-lifecycle-context.js";
import type { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import { SubagentRegistryMutationRejectedError } from "./subagent-registry-persistence.js";
import { selectRequesterTurnChildren } from "./subagent-registry-requester-yield.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Reconstruct requester claims without owning retries or altering failed cohort custody. */
export async function settleRestoredRequesterTurns({
  cfg,
  runs,
  stateContext,
  assertCurrent,
  settleRequesterTurn,
  retireSupersededRun,
}: {
  cfg: OpenClawConfig;
  runs: ReadonlyMap<string, SubagentRunRecord>;
  stateContext: OpenClawStateWorkerContext;
  assertCurrent: () => void;
  settleRequesterTurn: SubagentLifecycleController["settleRequesterTurnAfterSessionSpawns"];
  retireSupersededRun: SubagentLifecycleOptions["retireSupersededRun"];
}): Promise<unknown[]> {
  const requesterTurns = new Map<string, SubagentRunRecord>();
  const resolveRequesterAgentId = (entry: SubagentRunRecord) =>
    resolveSubagentRequesterAgentId(cfg, entry);
  for (const entry of runs.values()) {
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
      let entries = selectEntries((entry) => superseded.push(entry));
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
        entries = selectEntries(() => {
          throw new SubagentRegistryMutationRejectedError("Restored cohort changed");
        });
      }
      if (entries.length === 0) {
        continue;
      }
      await settleRequesterTurn(
        {
          requesterSessionKey: firstEntry.requesterSessionKey,
          stateContext,
          assertCurrent,
          requesterAgentId,
          requesterTurnRunId,
          requesterYielded: entries.every((entry) => entry.requesterTurnYielded === true),
          acceptedSessionSpawns: entries.map((entry) => ({
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
}
