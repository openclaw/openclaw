import { normalizeOptionalString as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { DecisionEvaluationReport } from "./decision-evaluation.js";

const QA_CONFIDENCE_VERDICTS = [
  "pass",
  "product-bug",
  "qa-harness-bug",
  "fixture-bug",
  "optional-gap",
  "mock-limitation",
  "environment-blocked",
] as const;

export type QaConfidenceVerdict = (typeof QA_CONFIDENCE_VERDICTS)[number];
export type QaConfidenceLaneStatus = "pass" | "fail" | "blocked" | "missing" | "unknown";
export type QaConfidenceLaneEvaluation = {
  passed: boolean;
  details: string;
  skippedCount?: number;
  status?: QaConfidenceLaneStatus;
  verdict?: QaConfidenceVerdict;
  decisionEvaluation?: DecisionEvaluationReport;
};

export function readVerdict(value: unknown, key: string): QaConfidenceVerdict | undefined {
  const text = readString(value);
  if (!text) {
    return undefined;
  }
  if (!isQaConfidenceVerdict(text)) {
    throw new Error(
      `confidence manifest ${key} must be one of ${QA_CONFIDENCE_VERDICTS.join(", ")}`,
    );
  }
  return text;
}

export function isQaConfidenceVerdict(value: string): value is QaConfidenceVerdict {
  return QA_CONFIDENCE_VERDICTS.some((verdict) => verdict === value);
}

// Explicit unknown evidence bypasses failureVerdict; status-less failures are classified separately.
export function unknownLaneEvaluation(details: string): QaConfidenceLaneEvaluation {
  return { passed: false, status: "unknown", details };
}
