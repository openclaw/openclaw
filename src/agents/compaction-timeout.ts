const safetyTimeoutReason = Symbol.for("openclaw.compaction.safety-timeout-reason");
const timeoutAcceptanceOpen = Symbol.for("openclaw.compaction.timeout-acceptance-open");
const timeoutPartialResult = Symbol.for("openclaw.compaction.timeout-partial-result");

/** Timeout reason owned by the embedded native compaction safety wrapper. */
export class CompactionSafetyTimeoutError extends Error {
  override name = "CompactionTimeoutError";
  readonly [safetyTimeoutReason] = true;
  [timeoutAcceptanceOpen] = true;

  constructor() {
    super("Compaction timed out");
  }
}

export function isCompactionSafetyTimeoutError(
  value: unknown,
): value is CompactionSafetyTimeoutError {
  return (
    typeof value === "object" &&
    value !== null &&
    safetyTimeoutReason in value &&
    value[safetyTimeoutReason] === true
  );
}

type TimeoutPartialResult = {
  readonly [timeoutPartialResult]: true;
};

/** Mark one in-process result as safe to commit during the timeout settlement window. */
export function markCompactionTimeoutPartialResult<T extends object>(
  value: T,
): T & TimeoutPartialResult {
  Object.defineProperty(value, timeoutPartialResult, { value: true });
  return value as T & TimeoutPartialResult;
}

export function isCompactionTimeoutPartialResult(value: unknown): value is TimeoutPartialResult {
  return typeof value === "object" && value !== null && timeoutPartialResult in value;
}

export function expireCompactionTimeoutResultAcceptance(reason: unknown): void {
  if (isCompactionSafetyTimeoutError(reason)) {
    reason[timeoutAcceptanceOpen] = false;
  }
}

export function acceptsCompactionTimeoutPartialResult(reason: unknown, result: unknown): boolean {
  return (
    isCompactionSafetyTimeoutError(reason) &&
    reason[timeoutAcceptanceOpen] === true &&
    isCompactionTimeoutPartialResult(result)
  );
}
