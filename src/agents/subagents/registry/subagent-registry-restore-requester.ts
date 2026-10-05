import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import type { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Reconstruct requester claims without owning retries or altering failed cohort custody. */
export async function settleRestoredRequesterTurns({
  cfg,
  runs,
  stateContext,
  assertCurrent,
  settleRequesterTurn,
}: {
  cfg: OpenClawConfig;
  runs: ReadonlyMap<string, SubagentRunRecord>;
  stateContext: OpenClawStateWorkerContext;
  assertCurrent: () => void;
  settleRequesterTurn: SubagentLifecycleController["settleRequesterTurnAfterSessionSpawns"];
}): Promise<unknown[]> {
  const requesterTurns = new Map<string, Map<string, SubagentRunRecord[]>>();
  const resolveRequesterAgentId = (entry: SubagentRunRecord) =>
    resolveSubagentRequesterAgentId(cfg, entry);
  for (const entry of runs.values()) {
    const requesterTurnRunId = entry.requesterTurnRunId?.trim();
    if (!requesterTurnRunId || entry.expectsCompletionMessage !== true) {
      continue;
    }
    const requesterIdentity = `${resolveRequesterAgentId(entry) ?? "unknown"}\0${entry.requesterSessionKey}`;
    let turns = requesterTurns.get(requesterIdentity);
    if (!turns) {
      turns = new Map();
      requesterTurns.set(requesterIdentity, turns);
    }
    const entries = turns.get(requesterTurnRunId) ?? [];
    entries.push(entry);
    turns.set(requesterTurnRunId, entries);
  }
  const transferFailures: unknown[] = [];
  for (const [, turns] of requesterTurns) {
    for (const [requesterTurnRunId, entries] of turns) {
      const firstEntry = entries[0];
      if (!firstEntry) {
        continue;
      }
      assertCurrent();
      try {
        await settleRequesterTurn(
          {
            requesterSessionKey: firstEntry.requesterSessionKey,
            stateContext,
            assertCurrent,
            requesterAgentId: resolveRequesterAgentId(firstEntry),
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
  }
  return transferFailures;
}
