import type {
  DecisionAnswer,
  DecisionBatch,
  DecisionBatchResult,
} from "openclaw/plugin-sdk/decisions";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { z } from "zod";

const jsonValue = z.json();
const probability = z.number().finite().min(0).max(1);
const nonEmpty = z.string().min(1);
const obj = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();
const ownKeys = (value: object) => Object.getOwnPropertyNames(value);
const ownMap = <T extends z.ZodType>(value: T, key = z.string()) =>
  z.custom<Record<string, z.infer<T>>>((input) => {
    if (!isRecord(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
      return false;
    }
    return ownKeys(input).every(
      (name) => key.safeParse(name).success && value.safeParse(input[name]).success,
    );
  });
const entry = z.union([z.string(), z.null(), z.array(jsonValue), ownMap(jsonValue)]);
const provenance = obj({
  providerId: nonEmpty,
  rubricVersion: nonEmpty,
  runtimeGeneration: nonEmpty,
});
const q = <T extends z.ZodType, C extends z.ZodType>(type: T, criteria: C) =>
  obj({ type, instructions: entry.optional(), criteria });

const questionSchema = z.discriminatedUnion("type", [
  q(
    z.literal("choice"),
    ownMap(entry, nonEmpty).refine((v) => ownKeys(v).length >= 2),
  ),
  q(
    z.literal("boolean"),
    z.object({ true: entry.optional(), false: entry.optional() }).strict().nullable().optional(),
  ),
  q(z.literal("score"), z.array(entry).min(2)),
]);
const batchSchema = obj({
  state: entry,
  questions: ownMap(questionSchema, nonEmpty).refine((v) => ownKeys(v).length > 0),
});
const answerSchema = z.discriminatedUnion("type", [
  obj({
    type: z.literal("choice"),
    choice: nonEmpty,
    probabilities: ownMap(probability),
    confidence: z.number().finite().optional(),
  }),
  obj({ type: z.literal("boolean"), probabilityTrue: probability }),
  obj({
    type: z.literal("score"),
    score: z.number().finite(),
    probabilities: z.array(probability).min(1),
    confidence: z.number().finite().optional(),
  }),
]);
const resultSchema = obj({
  model: nonEmpty,
  answers: ownMap(answerSchema),
  usage: obj({
    inputTokens: z.number().finite().nonnegative().optional(),
    outputTokens: z.number().finite().nonnegative().optional(),
  }).optional(),
});
const expectation = z.discriminatedUnion("kind", [
  obj({
    kind: z.literal("choice"),
    acceptable: z
      .array(nonEmpty)
      .min(1)
      .refine((v) => new Set(v).size === v.length),
  }),
  obj({
    kind: z.literal("boolean"),
    expected: z.boolean(),
    operator: z.enum(["gte", "gt", "lte", "lt"]),
    threshold: probability,
  }),
  obj({
    kind: z.literal("score"),
    interval: obj({ min: z.number().finite(), max: z.number().finite() }).refine(
      (v) => v.min <= v.max,
    ),
  }),
]);
const referenceSchema = obj({
  status: z.enum(["reviewed", "unreviewed", "disputed", "unscorable"]),
  expectations: ownMap(expectation).optional(),
  provenance: ownMap(jsonValue).optional(),
});
const okOutcome = obj({
  caseId: nonEmpty,
  status: z.literal("ok"),
  result: resultSchema,
  provenance,
});
const executionOutcome = obj({
  caseId: nonEmpty,
  status: z.enum(["missing", "not-started", "invalid-response", "cancelled", "unavailable"]),
  reason: z.string().optional(),
  provenance: provenance.optional(),
});
const outcome = z.union([okOutcome, executionOutcome]);
const artifact = obj({
  version: z.literal(1),
  fixtureId: nonEmpty,
  cases: z.array(z.unknown()),
  outcomes: z.array(z.unknown()),
});
const caseRecord = obj({ id: nonEmpty });
const outcomeRecord = obj({ caseId: nonEmpty });

type Reference = z.infer<typeof referenceSchema>;
type Outcome = z.infer<typeof outcome>;
type Expectation = z.infer<typeof expectation>;
type Status = Outcome["status"];
type RefStatus = Reference["status"] | "missing";
type Row = {
  caseId: string;
  case: unknown;
  outcomeStatus: Status;
  referenceStatus: RefStatus;
  scored: boolean;
  agreement: "agree" | "disagree" | "not-scored";
  outcome: unknown;
};
export type DecisionEvaluationReport = ReturnType<typeof summarize>;
export function evaluateDecisionEvaluationSummary(input: unknown) {
  const decisionEvaluation = evaluateDecisionEvaluationArtifact(input);
  const passed = decisionEvaluation.pipelinePass;
  return {
    passed,
    ...(passed ? {} : { status: "unknown" as const }),
    details: passed
      ? `decision evaluation pipeline valid: scheduled=${decisionEvaluation.counts.scheduled}, scored=${decisionEvaluation.counts.scored}, disagreed=${decisionEvaluation.counts.disagreed}, unscored=${decisionEvaluation.counts.unscored}`
      : `decision evaluation ${decisionEvaluation.issues.join("; ") || "decision evaluation pipeline failed"}`,
    decisionEvaluation,
  };
}

function summarize(fixtureId: string, issues: string[], rows: Row[]) {
  const count = (test: (row: Row) => boolean) => rows.filter(test).length;
  return {
    version: 1,
    fixtureId,
    pipelinePass: issues.length === 0,
    issues,
    rows,
    counts: {
      scheduled: rows.length,
      scored: count((r) => r.scored),
      unscored: count((r) => !r.scored),
      agreed: count((r) => r.agreement === "agree"),
      disagreed: count((r) => r.agreement === "disagree"),
    },
  };
}
const exactKeys = (left: object, right: object) =>
  ownKeys(left).length === ownKeys(right).length &&
  ownKeys(left).every((key) => Object.hasOwn(right, key));

function expectationMatches(
  question: DecisionBatch["questions"][string],
  expected: Expectation,
): boolean {
  if (expected.kind !== question.type) {
    return false;
  }
  if (expected.kind === "choice" && question.type === "choice") {
    return expected.acceptable.every((label) => Object.hasOwn(question.criteria, label));
  }
  return (
    expected.kind !== "score" ||
    question.type !== "score" ||
    (expected.interval.min >= 0 && expected.interval.max <= question.criteria.length - 1)
  );
}

function resultMatches(batch: DecisionBatch, result: DecisionBatchResult): boolean {
  if (!exactKeys(result.answers, batch.questions)) {
    return false;
  }
  return Object.entries(batch.questions).every(([id, question]) => {
    const answer = result.answers[id];
    if (!answer || answer.type !== question.type) {
      return false;
    }
    if (question.type === "choice") {
      return (
        answer.type === "choice" &&
        Object.hasOwn(question.criteria, answer.choice) &&
        exactKeys(answer.probabilities, question.criteria) &&
        Object.values(answer.probabilities).some((p) => p > 0)
      );
    }
    return (
      question.type !== "score" ||
      (answer.type === "score" &&
        answer.score >= 0 &&
        answer.score <= question.criteria.length - 1 &&
        answer.probabilities.length === question.criteria.length &&
        answer.probabilities.some((p) => p > 0))
    );
  });
}

function referenceMatches(batch: DecisionBatch, reference: Reference | undefined): boolean {
  if (!reference) {
    return true;
  }
  if (reference.status !== "reviewed") {
    return !reference.expectations;
  }
  const questions = batch.questions;
  return (
    reference.expectations !== undefined &&
    exactKeys(reference.expectations, questions) &&
    Object.entries(reference.expectations).every(
      ([id, expected]) => questions[id] && expectationMatches(questions[id], expected),
    )
  );
}

function relationalIssues(
  cases: Array<{ id: string }>,
  outcomes: Array<{ caseId: string }>,
): string[] {
  const caseIds = new Set(cases.map((item) => item.id));
  const outcomeIds = new Set(outcomes.map((item) => item.caseId));
  const issues = [...outcomeIds]
    .filter((id) => !caseIds.has(id))
    .map((id) => `outcome references unknown case ${id}`);
  if (caseIds.size !== cases.length) {
    issues.push("duplicate case IDs");
  }
  if (outcomeIds.size !== outcomes.length) {
    issues.push("duplicate outcome case IDs");
  }
  return issues;
}

function agrees(answer: DecisionAnswer, expected: Expectation): boolean {
  if (expected.kind === "choice" && answer.type === "choice") {
    return expected.acceptable.includes(answer.choice);
  }
  if (expected.kind === "boolean" && answer.type === "boolean") {
    const value = answer.probabilityTrue;
    const selected =
      expected.operator === "gte"
        ? value >= expected.threshold
        : expected.operator === "gt"
          ? value > expected.threshold
          : expected.operator === "lte"
            ? value <= expected.threshold
            : value < expected.threshold;
    return selected === expected.expected;
  }
  return (
    expected.kind === "score" &&
    answer.type === "score" &&
    answer.score >= expected.interval.min &&
    answer.score <= expected.interval.max
  );
}

/** Deterministic offline replay; parsing and relational checks are fail-closed. */
function evaluateDecisionEvaluationArtifact(input: unknown): DecisionEvaluationReport {
  const parsed = artifact.safeParse(input);
  if (!parsed.success) {
    return summarize("invalid", ["decision evaluation artifact failed schema validation"], []);
  }
  const value = parsed.data;
  const issues: string[] = [];
  const cases: Array<{ raw: unknown; value: z.infer<typeof caseRecord> }> = [];
  for (const [index, raw] of value.cases.entries()) {
    const checked = caseRecord.safeParse(raw);
    if (!checked.success) {
      issues.push(`cases[${index}]: invalid record`);
      continue;
    }
    cases.push({ raw, value: checked.data });
  }
  const outcomes: Array<{ raw: unknown; value: z.infer<typeof outcomeRecord> }> = [];
  for (const [index, raw] of value.outcomes.entries()) {
    const checked = outcomeRecord.safeParse(raw);
    if (!checked.success) {
      issues.push(`outcomes[${index}]: invalid record`);
      continue;
    }
    outcomes.push({ raw, value: checked.data });
  }
  issues.push(
    ...relationalIssues(
      cases.map((item) => item.value),
      outcomes.map((item) => item.value),
    ),
  );
  if (!cases.length) {
    issues.push("fixture cases must not be empty");
  }
  const outcomesByCaseId = new Map(outcomes.map((item) => [item.value.caseId, item]));
  const rows: Row[] = [];
  for (const item of cases) {
    const captured = outcomesByCaseId.get(item.value.id);
    const raw = captured?.raw ?? {
      caseId: item.value.id,
      status: "missing",
      reason: "no captured outcome",
    };
    const checkedBatch = batchSchema.safeParse(item.value.batch);
    const checkedReference =
      item.value.reference === undefined
        ? undefined
        : referenceSchema.safeParse(item.value.reference);
    const checkedOutcome = outcome.safeParse(raw);
    const typedBatch = checkedBatch.success ? checkedBatch.data : undefined;
    const refValue = checkedReference?.success ? checkedReference.data : undefined;
    const execution = checkedOutcome.success ? checkedOutcome.data : undefined;
    const validGroupId = nonEmpty.optional().safeParse(item.value.groupId).success;
    const validReference =
      item.value.reference === undefined ||
      Boolean(checkedReference?.success && typedBatch && referenceMatches(typedBatch, refValue));
    const validCase = Boolean(typedBatch && validGroupId && validReference);
    const invalidResult =
      !execution ||
      (execution.status === "ok" && (!typedBatch || !resultMatches(typedBatch, execution.result)));
    const outcomeStatus = invalidResult ? "invalid-response" : execution!.status;
    if (!validCase) {
      issues.push(
        `case ${item.value.id}: invalid fixture or missing expectation for every question`,
      );
    }
    if (outcomeStatus !== "ok") {
      issues.push(`case ${item.value.id}: outcome status=${outcomeStatus}`);
    }
    let agreement: Row["agreement"] = "not-scored";
    if (
      validCase &&
      outcomeStatus === "ok" &&
      execution?.status === "ok" &&
      refValue?.status === "reviewed" &&
      refValue.expectations
    ) {
      agreement = Object.entries(refValue.expectations).every(([id, expected]) =>
        agrees(execution.result.answers[id]!, expected),
      )
        ? "agree"
        : "disagree";
    }
    rows.push({
      caseId: item.value.id,
      case: item.raw,
      outcomeStatus,
      referenceStatus:
        refValue?.status ?? (item.value.reference === undefined ? "missing" : "unscorable"),
      outcome: raw,
      scored: agreement !== "not-scored",
      agreement,
    });
  }
  return summarize(value.fixtureId, issues, rows);
}
