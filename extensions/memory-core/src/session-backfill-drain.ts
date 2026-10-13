import type {
  SessionBackfillExecution,
  SessionBackfillResult,
} from "./session-backfill-contract.js";

export const SESSION_BACKFILL_TOP_CANDIDATE_LIMIT = 5;
const MAX_SESSION_BACKFILL_APPLY_BATCHES = 10_000;

export async function drainSessionBackfill(params: {
  executeBatch: () => Promise<SessionBackfillExecution>;
}): Promise<SessionBackfillResult> {
  const batches: SessionBackfillExecution[] = [];
  for (let batch = 1; batch <= MAX_SESSION_BACKFILL_APPLY_BATCHES; batch += 1) {
    const execution = await params.executeBatch();
    batches.push(execution);
    if (!execution.continuation.hasMore) {
      return aggregateSessionBackfillBatches(batches, SESSION_BACKFILL_TOP_CANDIDATE_LIMIT);
    }
    if (!execution.continuation.advanced) {
      throw new Error(
        `Memory session-backfill stopped after ${batch} batches because the ingestion cursor did not advance.`,
      );
    }
  }
  throw new Error(
    `Memory session-backfill exceeded the ${MAX_SESSION_BACKFILL_APPLY_BATCHES}-batch safety limit.`,
  );
}

function aggregateSessionBackfillBatches(
  executions: SessionBackfillExecution[],
  topCandidateLimit: number,
): SessionBackfillResult {
  const first = executions[0]?.result;
  if (!first) {
    throw new Error("Memory session-backfill completed without executing a batch.");
  }
  const days = new Map<string, SessionBackfillResult["days"][number]>();
  for (const execution of executions) {
    for (const day of execution.result.days) {
      const current = days.get(day.day);
      days.set(day.day, {
        day: day.day,
        candidateCount: (current?.candidateCount ?? 0) + day.candidateCount,
        topCandidates: [...(current?.topCandidates ?? []), ...day.topCandidates].slice(
          0,
          topCandidateLimit,
        ),
      });
    }
  }
  const total = (
    field: "candidateCount" | "stagedEntries" | "writtenDiaryEntries" | "replacedDiaryEntries",
  ) => executions.reduce((sum, { result }) => sum + result[field], 0);
  return {
    ...first,
    days: [...days.values()].toSorted((a, b) => a.day.localeCompare(b.day)),
    candidateCount: total("candidateCount"),
    stagedEntries: total("stagedEntries"),
    writtenDiaryEntries: total("writtenDiaryEntries"),
    replacedDiaryEntries: total("replacedDiaryEntries"),
    batchCount: executions.length,
    batches: executions.map((execution, index) => ({
      batch: index + 1,
      days: execution.result.days.length,
      candidates: execution.result.candidateCount,
      stagedEntries: execution.result.stagedEntries,
    })),
  };
}
