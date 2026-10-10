import { captureExecRequestCancellation } from "../../bash-process-control.js";
import type { SubagentKillSession } from "./subagent-control-session.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";

/** Native admission may create its request owner after the initial Stop selection. */
export function captureSubagentCommands(entry: SubagentRunRecord, session?: SubagentKillSession) {
  const sessionId = session?.entry?.sessionId;
  if (!session || !sessionId) {
    return undefined;
  }
  const agentId = session.agentId;
  const observations: ReturnType<typeof captureExecRequestCancellation>[] = [];
  const observe = (current: SubagentRunRecord | undefined) => {
    if (!current || !isSameSubagentRunOwner(current, entry)) {
      return;
    }
    observations.push(
      captureExecRequestCancellation({
        runId: current.runId,
        sessionKey: current.childSessionKey,
        sessionId,
        agentId,
      }),
    );
  };
  observe(entry);
  return {
    observe,
    get owners() {
      return [...new Set(observations.flatMap((observation) => observation.owners))];
    },
    cancel(assertCurrent: () => void) {
      let aborted = false;
      for (const observation of observations) {
        if (observation.owners.some((owner) => !owner.signal.aborted)) {
          assertCurrent();
        }
        aborted = observation.cancel() || aborted;
      }
      return aborted;
    },
    async settle() {
      const results = await Promise.allSettled(
        observations.map((observation) => observation.settle()),
      );
      const errors: unknown[] = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "Captured native command cleanup was incomplete");
      }
    },
  };
}
