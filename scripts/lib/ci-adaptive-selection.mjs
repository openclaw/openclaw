import assert from "node:assert/strict";
import {
  isObservationPath,
  observationContext,
  observationFile,
  observationFileId,
} from "./ci-test-observations.mjs";

const compatibilityFields = ["repository", "configDigest", "lockDigest", "environmentDigest"];
const sameContext = (a, b) => compatibilityFields.every((key) => a[key] === b[key]);
const globalChange = (file) =>
  /^(?:\.github\/|scripts\/|test\/vitest\/|(?:[^/]+\/)*tsconfig[^/]*\.json$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$)/u.test(
    file,
  );

/**
 * Produce an experiment plan only. scheduledFiles always contains the full input inventory.
 * @param {unknown} [recommendations]
 */
export function planAdaptiveSelection(observations, request, recommendations = null) {
  assert(request?.version === 1 && observations?.version === 1, "Unsupported selection input");
  const current = observationContext(request.context);
  const baseline = observationContext(observations.context);
  assert(
    Array.isArray(request.files) && Array.isArray(request.changedFiles),
    "Missing current inventory/diff",
  );
  const files = request.files.map(observationFile);
  const ids = new Set(files.map(observationFileId));
  assert(ids.size === files.length, "Duplicate current file identity");
  assert(request.changedFiles.every(isObservationPath), "Invalid changed path");
  assert(Array.isArray(observations.invocations), "Missing baseline invocations");
  assert(typeof request.audit === "boolean", "Declare whether this is a full-run audit");
  assert(
    typeof request.baselineRevision === "string" && typeof request.baselineTree === "string",
    "Missing diff baseline",
  );
  const changed = new Set(request.changedFiles);
  const fallbackReasons = [];
  if (!sameContext(current, baseline)) {
    fallbackReasons.push("incompatible-context");
  }
  if (request.baselineRevision !== baseline.revision || request.baselineTree !== baseline.tree) {
    fallbackReasons.push("wrong-diff-baseline");
  }
  if (request.changedFiles.some(globalChange)) {
    fallbackReasons.push("global-input-change");
  }
  if (request.audit) {
    fallbackReasons.push("full-run-audit");
  }

  const history = new Map();
  const knownPaths = new Set(files.map((file) => file.file));
  for (const invocation of observations.invocations) {
    assert(Array.isArray(invocation.files), "Missing observation files");
    for (const row of invocation.files) {
      const file = observationFile(row);
      const id = observationFileId(file);
      const rows = history.get(id) ?? [];
      const dependencies =
        Array.isArray(row.dependencies) && row.dependencies.every(isObservationPath)
          ? row.dependencies
          : null;
      rows.push({
        complete: row.complete === true && invocation.complete === true,
        outcome: row.outcome,
        dependencies,
      });
      history.set(id, rows);
      for (const dependency of dependencies ?? []) {
        knownPaths.add(dependency);
      }
    }
  }
  if (request.changedFiles.some((file) => !knownPaths.has(file))) {
    fallbackReasons.push("unmapped-changed-path");
  }

  const alwaysRun = request.alwaysRun ?? [];
  assert(Array.isArray(alwaysRun) && alwaysRun.every(isObservationPath), "Invalid mandatory paths");
  assert(
    alwaysRun.every((file) => files.some((entry) => entry.file === file)),
    "Unknown mandatory test file",
  );
  const suggested = new Set();
  if (recommendations !== null) {
    const context = observationContext(recommendations.context);
    assert(
      recommendations.version === 1 &&
        sameContext(context, current) &&
        context.revision === current.revision &&
        context.tree === current.tree,
      "Stale model recommendations",
    );
    assert(Array.isArray(recommendations.selectedFiles), "Missing model selections");
    for (const row of recommendations.selectedFiles) {
      const id = observationFileId(observationFile(row));
      assert(ids.has(id), "Unknown model-selected file");
      suggested.add(id);
    }
  }

  const candidates = [];
  for (const file of files) {
    const id = observationFileId(file);
    const rows = history.get(id) ?? [];
    const reasons = [...fallbackReasons];
    if (alwaysRun.includes(file.file)) {
      reasons.push("mandatory");
    }
    if (rows.length === 0) {
      reasons.push("missing-history");
    }
    if (rows.some((row) => !row.complete || row.outcome !== "passed" || !row.dependencies)) {
      reasons.push("incomplete-or-failing-history");
    }
    if (rows.some((row) => row.dependencies?.some((dependency) => changed.has(dependency)))) {
      reasons.push("dependency-change");
    }
    if (suggested.has(id)) {
      reasons.push("model-recommendation");
    }
    if (reasons.length > 0) {
      candidates.push({ ...file, reasons });
    }
  }
  return {
    version: 1,
    mode: "shadow",
    context: current,
    baselineRevision: baseline.revision,
    fallbackReasons,
    scheduledFiles: files,
    candidateFiles: candidates,
    scheduledCount: files.length,
    candidateCount: candidates.length,
    // Count only; parallelism and setup prevent translating file count to saved time.
    candidateOmittedCount: files.length - candidates.length,
  };
}
