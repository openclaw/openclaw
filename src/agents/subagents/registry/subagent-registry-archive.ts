import { randomUUID } from "node:crypto";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { getSubagentSweepRuns, subagentRuns } from "./subagent-registry-memory.js";
import {
  mutateSubagentRuns,
  runSubagentRegistryWorkerWrite,
} from "./subagent-registry-persistence.js";
import {
  isSubagentKeepRunArchiveDue,
  SUBAGENT_ARCHIVE_BATCH_ROWS,
} from "./subagent-registry-work-index.js";
import { parseSubagentRegistryWriteReceipt } from "./subagent-registry.store.codec.js";
import type { SubagentRegistryWrite } from "./subagent-registry.store.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** One maintenance pass reserves at most 128 rows; payloads stay in the worker. */
export async function archiveCompletedSubagentRuns(
  now: number,
  runs: Map<string, SubagentRunRecord> = subagentRuns,
): Promise<number> {
  const ids: string[] = [];
  for (const entry of getSubagentSweepRuns(runs, now)) {
    if (isSubagentKeepRunArchiveDue(entry, now)) {
      ids.push(entry.runId);
    }
    if (ids.length === SUBAGENT_ARCHIVE_BATCH_ROWS) {
      break;
    }
  }
  if (!ids.length) {
    return 0;
  }
  const context = captureOpenClawStateWorkerContext();
  const archived = await mutateSubagentRuns(
    ids,
    (rows) => ({
      value: [...rows.values()]
        .filter((row) => isSubagentKeepRunArchiveDue(row, now))
        .map((row) => row.runId),
    }),
    {
      runs,
      context,
      hydratePayloads: false,
      async commit(planned, authority) {
        if (!planned.value.length) {
          return planned;
        }
        const write: SubagentRegistryWrite = {
          writeId: randomUUID(),
          values: [],
          deleteRunIds: [],
          archive: { runIds: planned.value, now },
        };
        return runSubagentRegistryWorkerWrite(context, () => ({
          kind: "registry",
          writeId: write.writeId,
          assertCurrent: authority.assertCurrent,
          terminalEvents: undefined,
          execute: (scope) => scope.execute({ type: "subagents.persistChanges", input: write }),
          decode(value) {
            const receipt = parseSubagentRegistryWriteReceipt(value, write);
            const archivedRunIds = receipt.archivedRunIds!;
            return {
              value: archivedRunIds,
              archivedRunIds,
              postimages: new Map(archivedRunIds.map((id) => [id, null])),
            };
          },
        }));
      },
    },
  );
  return archived.length;
}
