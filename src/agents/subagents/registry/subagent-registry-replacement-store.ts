import { isDeepStrictEqual } from "node:util";
import { runOpenClawStateWriteTransaction } from "../../../state/openclaw-state-db.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { publishSubagentRunsAfterAtomicStore } from "./subagent-registry-state.js";
import { bindSubagentRunRecord } from "./subagent-registry.store.codec.js";
import {
  deleteSubagentRunRowInDatabase,
  upsertSubagentRunRowInDatabase,
} from "./subagent-registry.store.kernel.js";
import { readSubagentRun } from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Transfers a child execution and its frozen requester cohort in one native-owner commit. */
export function commitSubagentRunReplacement(params: {
  runs: Map<string, SubagentRunRecord>;
  changedRunIds: readonly string[];
  source: SubagentRunRecord;
  successor: SubagentRunRecord;
}): void {
  if (
    params.successor.childSessionKey !== params.source.childSessionKey ||
    params.successor.taskRunId !== (params.source.taskRunId ?? params.source.runId) ||
    (params.successor.generation ?? 0) <= (params.source.generation ?? 0)
  ) {
    throw new Error("replacement subagent does not share the source execution identity");
  }
  const rows = params.changedRunIds.flatMap((id) => {
    const entry = params.runs.get(id);
    return entry ? [bindSubagentRunRecord(entry)] : [];
  });
  const deleted = params.changedRunIds.filter((id) => !params.runs.has(id));
  const sourceRow = bindSubagentRunRecord(params.source);
  runOpenClawStateWriteTransaction(
    (database) => {
      const stored = readSubagentRun(database, params.source.runId);
      if (!stored || !isDeepStrictEqual(bindSubagentRunRecord(stored), sourceRow)) {
        throw new Error("replacement subagent source changed before commit");
      }
      for (const row of rows) {
        upsertSubagentRunRowInDatabase(database, row);
      }
      for (const id of deleted) {
        deleteSubagentRunRowInDatabase(database, id);
      }
    },
    undefined,
    { operationLabel: "subagent execution replacement" },
  );
  subagentRuns.commitOwnership(params.successor);
  const events: Array<() => void> = [];
  publishSubagentRunsAfterAtomicStore(params.runs, params.changedRunIds, events);
  for (const emit of events) {
    emit();
    if (params.runs.get(params.successor.runId) !== params.successor) {
      break;
    }
  }
}
