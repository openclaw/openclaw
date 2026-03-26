import type { SessionRetryReport } from "../config/sessions/types.js";

export function buildRetryReport(params: {
  generatedAt: number;
  maxAttempts: number;
  attemptsUsed: number;
  exhausted?: boolean;
  entries: SessionRetryReport["entries"];
}): SessionRetryReport {
  const maxAttempts = Math.max(1, params.maxAttempts);
  const attemptsUsed = Math.max(0, params.attemptsUsed);
  const retriesUsed = Math.max(0, attemptsUsed - 1);
  const remainingRetries = Math.max(0, maxAttempts - attemptsUsed);
  return {
    status: params.exhausted ? "exhausted" : retriesUsed > 0 ? "used" : "unused",
    generatedAt: params.generatedAt,
    maxAttempts,
    attemptsUsed,
    retriesUsed,
    remainingRetries,
    ...(params.exhausted ? { exhaustedReason: "retry_limit" as const } : {}),
    entries: params.entries.map((entry) => ({ ...entry })),
  };
}
