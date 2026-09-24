import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { buildQaConfidenceReport, renderQaConfidenceMarkdownReport } from "./confidence-report.js";
import { evaluateDecisionEvaluationSummary } from "./decision-evaluation.js";

const evaluate = (input: unknown) => evaluateDecisionEvaluationSummary(input).decisionEvaluation;

const artifactPath = "qa/scenarios/decision-evaluation/synthetic-v1.json";
const fixture = () => JSON.parse(fs.readFileSync(artifactPath, "utf8"));
describe("Decision replay", () => {
  it("retains exact input facts and deterministically scores all cases", () => {
    const input = fixture();
    input.outcomes[0].result.answers.color.confidence = 2;
    const report = evaluate(input);
    expect(evaluate(input)).toEqual(report);
    expect(report).toMatchObject({
      pipelinePass: true,
      counts: { scheduled: 5, scored: 3, agreed: 2, disagreed: 1, unscored: 2 },
    });
    for (const [index, row] of report.rows.entries()) {
      expect(row.case).toEqual(input.cases[index]);
      expect(row.outcome).toEqual(input.outcomes[index]);
    }
  });
  it.each(["gte", "gt", "lte", "lt"])("scores both Boolean labels with %s", (operator) => {
    const input = fixture();
    const reference = input.cases[1].reference.expectations.square;
    Object.assign(reference, { operator, threshold: 0.9 });
    for (const expected of [true, false]) {
      reference.expected = expected;
      const selected = operator === "gte" || operator === "lte";
      expect(evaluate(input).rows[1]?.agreement).toBe(selected === expected ? "agree" : "disagree");
    }
  });
  it.each(["missing", "not-started", "invalid-response", "cancelled", "unavailable"])(
    "accounts for %s",
    (status) => {
      const input = fixture();
      if (status === "missing") {
        input.outcomes.shift();
      } else {
        input.outcomes[0] = { caseId: "color", status, reason: "synthetic control" };
      }
      expect(evaluate(input)).toMatchObject({
        pipelinePass: false,
        counts: { scheduled: 5, unscored: 3 },
        rows: [{ outcomeStatus: status, scored: false }, {}, {}, {}, {}],
      });
    },
  );
  it.each([
    ["cases.0.batch.state", 3],
    ["outcomes.0.result.answers.color.probabilities", { blue: 0, red: 0 }],
    ["cases.2.reference.expectations.mark.interval", { min: 3.2, max: 3.5 }],
    ["cases.0.batch.questions.color.criteria", { blue: "single choice" }],
    ["cases.1.batch.questions.square.criteria", "invalid"],
    ["outcomes.2.result.answers.mark.probabilities", { a: 1 }],
    ["outcomes.0.provenance", { providerId: "only" }],
    ["cases.5", fixture().cases[0]],
    ["outcomes.5", fixture().outcomes[0]],
    ["outcomes.0.caseId", "unknown"],
    ["outcomes.0.result.answers.color.probabilities", { other: 1 }],
    ["cases.0.reference.expectations", {}],
  ])("rejects malformed or mismatched %s without losing rows", (field, value) => {
    const input = fixture();
    const keys = field.split(".");
    const leaf = keys.pop()!;
    const target = keys.reduce((current, key) => current[key], input);
    target[leaf] = value;
    if (field === "cases.0.batch.questions.color.criteria") {
      input.outcomes[0].result.answers.color.probabilities = { blue: 1 };
      input.cases[0].reference.expectations.color.acceptable = ["blue"];
    }
    const report = evaluate(input);
    expect(report.pipelinePass).toBe(false);
    expect(report.counts.scheduled).toBe(input.cases.length);
    expect(report.rows.map((row) => row.caseId)).toEqual(
      input.cases.map((item: { id: string }) => item.id),
    );
  });
  it.each([
    ["missing", (outcome: Record<string, unknown>) => delete outcome.caseId],
    ["null", (outcome: Record<string, unknown>) => Object.assign(outcome, { caseId: null })],
    ["empty", (outcome: Record<string, unknown>) => Object.assign(outcome, { caseId: "" })],
    ["wrong-type", (outcome: Record<string, unknown>) => Object.assign(outcome, { caseId: 7 })],
  ])("retains identifiable rows for an outcome with a %s ID", (_label, corrupt) => {
    const input = fixture();
    corrupt(input.outcomes[1]);
    const report = evaluate(input);
    expect(report).toMatchObject({ pipelinePass: false, counts: { scheduled: 5 } });
    expect(report.rows.map((row) => row.caseId)).toEqual(
      input.cases.map((item: { id: string }) => item.id),
    );
    expect(report.rows[1]).toMatchObject({ caseId: "square", outcomeStatus: "missing" });
    expect(report.issues).toContain("outcomes[1]: invalid record");
  });
  it("retains scheduled rows when a neighboring outcome is not an object", () => {
    const input = fixture();
    input.outcomes.splice(1, 0, null);
    const report = evaluate(input);
    expect(report).toMatchObject({ pipelinePass: false, counts: { scheduled: 5 } });
    expect(report.rows.map((row) => row.caseId)).toEqual(
      input.cases.map((item: { id: string }) => item.id),
    );
    expect(report.rows[1]).toMatchObject({ caseId: "square", outcomeStatus: "ok" });
    expect(report.rows[2]).toMatchObject({ caseId: "mark", outcomeStatus: "ok" });
    expect(report.rows[1]?.outcome).toEqual(input.outcomes[2]);
    expect(report.issues).toContain("outcomes[1]: invalid record");
  });
  it.each([null, {}, { id: null }, { id: "" }, { id: 7 }])(
    "retains valid cases beside malformed case %j",
    (invalid) => {
      const input = fixture();
      const original = evaluate(input);
      input.cases.splice(1, 0, invalid);
      const report = evaluate(input);
      expect(report.pipelinePass).toBe(false);
      expect(report.rows).toEqual(original.rows);
      expect(report.counts).toEqual(original.counts);
      expect(report.issues).toContain("cases[1]: invalid record");
    },
  );
  it("requires every question reference in a multi-question case", () => {
    const input = fixture();
    Object.assign(input.cases[0].batch.questions, input.cases[1].batch.questions);
    Object.assign(input.outcomes[0].result.answers, input.outcomes[1].result.answers);
    expect(evaluate(input).rows[0]).toMatchObject({ scored: false });
    Object.assign(input.cases[0].reference.expectations, input.cases[1].reference.expectations);
    input.cases[0].reference.expectations.color.acceptable = ["red"];
    expect(evaluate(input)).toMatchObject({ pipelinePass: true, counts: { disagreed: 1 } });
  });
  it.each(["groupId", "reference"])("keeps invalid %s separate from execution", (field) => {
    const input = fixture();
    input.cases[0][field] = 7;
    const report = evaluate(input);
    expect(report).toMatchObject({ pipelinePass: false, counts: { scheduled: 5 } });
    expect(report.rows[0]).toMatchObject({ outcomeStatus: "ok", scored: false });
    expect(report.rows[0]?.case).toEqual(input.cases[0]);
  });
  it("preserves __proto__ labels and rejects an extra invalid answer", () => {
    const valid = fixture();
    valid.cases[0].batch.questions.color.criteria = {
      blue: "Blue",
      red: "Red",
      ["__proto__"]: "Synthetic",
    };
    valid.outcomes[0].result.answers.color.probabilities = {
      blue: 0.81,
      red: 0.18,
      ["__proto__"]: 0,
    };
    valid.outcomes[0].result.answers.color.choice = "__proto__";
    valid.cases[0].reference.expectations.color.acceptable = ["__proto__"];
    expect(evaluate(valid)).toMatchObject({ pipelinePass: true, counts: { scored: 3, agreed: 3 } });

    const invalid = fixture();
    invalid.outcomes[0].result.answers = {
      ...invalid.outcomes[0].result.answers,
      ["__proto__"]: "not an answer",
    };
    const invalidReport = evaluate(invalid);
    expect(invalidReport.pipelinePass).toBe(false);
    expect(invalidReport.rows[0]).toMatchObject({
      outcomeStatus: "invalid-response",
      scored: false,
    });
  });
  it("keeps decision disagreements in the lane evidence while gating integrity", async () => {
    const report = await buildQaConfidenceReport({
      manifest: {
        version: 1,
        profile: "decision",
        lanes: [
          {
            id: "decision",
            title: "Decision",
            kind: "decision-evaluation-summary",
            artifact: artifactPath,
            required: true,
          },
        ],
      },
      artifactRoot: process.cwd(),
      strictGlobalPass: true,
    });
    expect(report.pass).toBe(true);
    expect(report.lanes[0]?.decisionEvaluation).toEqual(evaluate(fixture()));
    expect(renderQaConfidenceMarkdownReport(report)).toContain("disagreed=1, unscored=2");
  });
});
