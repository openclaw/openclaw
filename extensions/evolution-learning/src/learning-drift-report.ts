export type LearningDriftRecord = Readonly<{
  status?: string;
  summary?: string;
  tags?: readonly string[];
  adoptedBy?: string | null;
  adopted_by?: string | null;
  rollbackPointer?: unknown;
  rollback_pointer?: unknown;
}>;

export type LearningDriftReport = Readonly<{
  schemaVersion: 1;
  generatedAt: string;
  totals: {
    total: number;
    success: number;
    failure: number;
    timeout: number;
    fallback: number;
    rollback: number;
    adopted: number;
  };
  rates: {
    failureRate: number;
    timeoutRate: number;
    fallbackRate: number;
    rollbackRate: number;
    adoptionRate: number;
  };
}>;

function hasSignal(record: LearningDriftRecord, signal: string): boolean {
  const normalizedSignal = signal.toLowerCase();
  const tags = record.tags ?? [];
  if (tags.some((tag) => tag.toLowerCase().includes(normalizedSignal))) {
    return true;
  }
  return record.summary?.toLowerCase().includes(normalizedSignal) === true;
}

function rate(count: number, total: number): number {
  return total > 0 ? count / total : 0;
}

export function buildLearningDriftReport(params: {
  successPatterns?: readonly LearningDriftRecord[];
  failurePatterns?: readonly LearningDriftRecord[];
  generatedAt?: string;
}): LearningDriftReport {
  const successPatterns = params.successPatterns ?? [];
  const failurePatterns = params.failurePatterns ?? [];
  const records = [...successPatterns, ...failurePatterns];
  const total = records.length;
  const timeout = records.filter((record) => hasSignal(record, "timeout")).length;
  const fallback = records.filter((record) => hasSignal(record, "fallback")).length;
  const rollback = records.filter(
    (record) =>
      hasSignal(record, "rollback") ||
      record.status === "rolled_back" ||
      record.rollbackPointer !== undefined ||
      record.rollback_pointer !== undefined,
  ).length;
  const adopted = records.filter(
    (record) =>
      Boolean(record.adoptedBy) || Boolean(record.adopted_by) || record.status === "success",
  ).length;

  return {
    schemaVersion: 1,
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    totals: {
      total,
      success: successPatterns.length,
      failure: failurePatterns.length,
      timeout,
      fallback,
      rollback,
      adopted,
    },
    rates: {
      failureRate: rate(failurePatterns.length, total),
      timeoutRate: rate(timeout, total),
      fallbackRate: rate(fallback, total),
      rollbackRate: rate(rollback, total),
      adoptionRate: rate(adopted, total),
    },
  };
}
