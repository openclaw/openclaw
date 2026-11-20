import assert from "node:assert/strict";
import {
  decodeTestObservations,
  isObservationPath,
  observationContext,
  observationFile,
  observationFileId,
} from "./ci-test-observations.mjs";

const date = (value) => {
  assert(typeof value === "string" && Number.isFinite(Date.parse(value)), "Invalid recording time");
  return Date.parse(value);
};
const identities = (files) => {
  assert(Array.isArray(files), "Missing file inventory");
  const ids = files.map((file) => observationFileId(observationFile(file))).toSorted();
  assert(new Set(ids).size === ids.length, "Duplicate file identity");
  return ids;
};
const sameInventory = (actual, expected) =>
  assert.deepEqual(identities(actual), identities(expected), "Mismatched file inventory");

/** Read frozen decisions only. Outcomes never become model inputs or causal labels. */
export function evaluateAdaptiveCapture(capture) {
  assert(capture?.version === 1 && capture.source, "Missing observation export");
  const observations = decodeTestObservations(capture.observations);
  const context = observationContext(observations.context);
  assert(observations.invocations?.length === 1, "Expected one runtime invocation");
  const invocation = observations.invocations[0];
  assert(typeof invocation.id === "string" && invocation.id, "Missing invocation identity");
  assert(
    invocation.dependencyRoot === "" || isObservationPath(invocation.dependencyRoot),
    "Invalid dependency root",
  );
  const files = invocation.files;
  identities(files);
  for (const key of ["runtime", "runtimeVersion", "platform", "arch"]) {
    assert(typeof invocation[key] === "string" && invocation[key], "Missing runtime identity");
  }
  const startedAt = date(capture.source.startedAt);
  const exportedAt = date(capture.source.exportedAt);
  assert(startedAt <= exportedAt, "Export precedes execution");
  const snapshot = capture.preExecution;
  const decision = snapshot?.decision ?? null;
  let graph = null;
  let ranking = null;
  if (snapshot) {
    const before = decodeTestObservations(snapshot.observations);
    assert.deepEqual(observationContext(before.context), context, "Mismatched snapshot source");
    assert(before.invocations?.length === 1, "Mismatched snapshot invocation");
    sameInventory(before.invocations[0].files, files);
    assert(
      before.invocations[0].files.every(
        (file) => file.complete === false && file.outcome === "unknown",
      ),
      "Pre-execution snapshot contains outcomes",
    );
    for (const key of ["id", "dependencyRoot", "runtime", "runtimeVersion", "platform", "arch"]) {
      assert(before.invocations[0][key] === invocation[key], "Mismatched snapshot runtime");
    }
    assert(
      startedAt <= date(snapshot.recordedAt) && date(snapshot.recordedAt) <= exportedAt,
      "Snapshot outside execution",
    );
  }
  if (decision) {
    assert(decision.version === 1 && decision.mode === "shadow", "Unsupported decision");
    assert(
      startedAt <= date(decision.recordedAt) &&
        date(decision.recordedAt) <= date(snapshot.recordedAt),
      "Decision outside pre-execution capture",
    );
    sameInventory(decision.scheduledFiles, files);
    graph = decision.graph;
    ranking = decision.ranking ?? null;
    if (graph) {
      assert(decision.prior && decision.comparison, "Missing prediction prior");
      assert(graph.version === 1 && graph.mode === "shadow", "Unsupported graph");
      assert.deepEqual(observationContext(graph.context), context, "Mismatched prediction source");
      assert(
        graph.baselineRevision === decision.comparison.revision,
        "Mismatched comparison revision",
      );
      assert(date(decision.prior.createdAt) < startedAt, "Prior published after execution started");
      sameInventory(graph.scheduledFiles, files);
      const known = new Set(identities(files));
      assert(
        identities(graph.candidateFiles).every((id) => known.has(id)),
        "Unknown candidate",
      );
    } else {
      assert(!decision.prior && !decision.comparison && !ranking, "Prediction without graph");
    }
    if (ranking) {
      assert(ranking.version === 1, "Unsupported ranking");
      sameInventory(ranking.rows, files);
      assert(
        ranking.rows.every(
          (row) =>
            row.score === null ||
            (typeof row.score === "number" &&
              Number.isFinite(row.score) &&
              row.score >= 0 &&
              row.score <= 1),
        ),
        "Invalid recorded score",
      );
    }
  }
  const selected = new Set(graph?.candidateFiles.map(observationFileId));
  const scores = new Map(ranking?.rows.map((row) => [observationFileId(row), row.score]));
  const outcomes = { passed: 0, failed: 0, unknown: 0 };
  const selection = graph
    ? { selected: 0, omitted: 0, failedSelected: 0, failedOmitted: 0, unknown: 0 }
    : null;
  const failures = [];
  const buckets = new Map();
  let observedCompleteFileMs = 0;
  for (const file of files) {
    const id = observationFileId(file);
    const outcome =
      file.complete === true && ["passed", "failed"].includes(file.outcome)
        ? file.outcome
        : "unknown";
    outcomes[outcome] += 1;
    if (selection) {
      selection[selected.has(id) ? "selected" : "omitted"] += 1;
      if (outcome === "failed") {
        selection[selected.has(id) ? "failedSelected" : "failedOmitted"] += 1;
      }
      selection.unknown += Number(outcome === "unknown");
    }
    const score = scores.get(id) ?? null;
    if (ranking) {
      const bucket = buckets.get(score) ?? { score, passed: 0, failed: 0, unknown: 0 };
      bucket[outcome] += 1;
      buckets.set(score, bucket);
    }
    if (outcome !== "unknown" && Number.isFinite(file.durationMs) && file.durationMs >= 0) {
      observedCompleteFileMs += file.durationMs;
    }
    if (outcome === "failed") {
      failures.push({
        ...observationFile(file),
        graphSelected: graph ? selected.has(id) : null,
        recordedScore: score,
        causalStatus: "unattributed",
      });
    }
  }
  return {
    version: 1,
    mode: "recorded-evaluation",
    context,
    runtime: Object.fromEntries(
      ["runtime", "runtimeVersion", "platform", "arch"].map((key) => [key, invocation[key]]),
    ),
    prediction: ranking ? "graph-and-ranking" : graph ? "graph-only" : "unavailable",
    fallbackReasons: decision?.fallbackReasons ?? ["decision-not-recorded"],
    outcomes,
    selection,
    scoreBuckets: [...buckets.values()].toSorted((a, b) => (a.score ?? -1) - (b.score ?? -1)),
    failures,
    observedCompleteFileMs,
    limitations: [
      "Source, prior and artifact provenance require independent verification.",
      "Raw failures are not causal regression labels.",
      "Summed file durations are not wall time, CPU time or counterfactual savings.",
      "This report performs no inference and changes no test execution.",
    ],
  };
}
