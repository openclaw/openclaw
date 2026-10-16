import type { ContextEngineHostSupport } from "../../context-engine/host-compat.js";
import { drainPendingContextEngineTurnsBeforeRun } from "./context-engine-turn-attempt.js";

export async function beginContextEngineLogicalTurn(
  params: Omit<Parameters<typeof drainPendingContextEngineTurnsBeforeRun>[0], "admission"> & {
    host: ContextEngineHostSupport;
  },
) {
  const { host, ...turn } = params;
  const admission = turn.recorder?.getAdmissionReceipt();
  // An unpersisted recorder has no admission to fence yet; a committed turn must supply its receipt.
  if (turn.recorder && !admission && turn.recorder.hasPersisted()) {
    turn.lease.degradeBeforeStart("current-turn transcript admission receipt is unavailable");
  } else {
    turn.lease.selectForHost({
      host,
      operation: "agent-run",
      requiresDurableCommit: turn.recorder !== undefined,
    });
  }
  await drainPendingContextEngineTurnsBeforeRun({
    ...turn,
    admission: turn.recorder?.getAdmissionReceipt(),
  });
  return turn.lease.begin();
}
