import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";

export const CRON_FAILURE_DISMISSALS_KEY = "ui.inbox.cronFailed";

export function cronFailureTimestamp(job: {
  state?: {
    lastRunAtMs?: number;
    lastRunStatus?: string;
    lastStatus?: string;
    autoDisabled?: { atMs: number };
  };
}): number | undefined {
  const state = job.state;
  const disabledAtMs = state?.autoDisabled?.atMs;
  if ((state?.lastRunStatus ?? state?.lastStatus) === "error") {
    // One row acknowledges both failure causes. Older failures without a
    // run timestamp keep a stable identity across schedule edits.
    return Math.max(state?.lastRunAtMs ?? 0, disabledAtMs ?? 0);
  }
  return disabledAtMs;
}

export function readCronFailureDismissals(value: unknown): Map<string, number> {
  return new Map(
    Object.entries(asNullableRecord(value) ?? {}).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isSafeInteger(entry[1]) && entry[1] >= 0,
    ),
  );
}
