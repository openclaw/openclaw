// Shared measurement facts; callers supply comparison identities and acceptance policy.
import assert from "node:assert/strict";
import { isAbsolute } from "node:path";

const controlSource = "454004eab143e6bb25ee95f905fa650173e0c4a4";
const finite = (value) => Number.isFinite(value) && value >= 0;
const commit = (value) => /^[a-f0-9]{40}$/u.test(value ?? "");

// Both live measurement owners accept the same explicit comparison identities.
// This validates measurement inputs; it does not select a numerical ship policy.
export function comparisonPlanCells(plan, candidate) {
  assert.match(plan.contractId ?? "", /^[a-z0-9][a-z0-9._-]+$/iu);
  assert(Array.isArray(plan.cells), "Comparison plan must declare exact cells");
  const labels = plan.cells.map((cell) => cell.label).toSorted();
  assert.deepEqual(
    labels,
    [
      "candidate-grouped",
      "candidate-inline",
      ...(labels.includes("control-grouped") ? ["control-grouped"] : []),
      "upstream-grouped",
    ].toSorted(),
    "Declare upstream and candidate grouped/inline, with optional original control",
  );
  return plan.cells.map((cell) => {
    const role = cell.label.startsWith("candidate-")
      ? "candidate"
      : cell.label === "control-grouped"
        ? "control"
        : "upstream";
    assert.equal(cell.role, role, "Cell label must retain its declared role");
    assert.equal(cell.inline, cell.label === "candidate-inline");
    assert(isAbsolute(cell.cwd), "Cell cwd must be an explicit absolute path");
    assert(commit(cell.source), "Cell source must be an exact commit");
    assert(commit(cell.tree), "Cell tree must be an exact tree");
    if (role === "candidate") {
      assert.equal(cell.cwd, candidate.cwd, "Candidate cwd must match the selected harness");
      assert.equal(
        cell.source,
        candidate.source,
        "Candidate source must match the reviewed commit",
      );
      assert.equal(cell.tree, candidate.tree, "Candidate tree must match the reviewed tree");
    } else if (role === "control") {
      assert.equal(cell.source, controlSource, "Original control cannot be replaced");
    }
    return { ...cell, control: role === "control", integration: role === "upstream" };
  });
}

export function distribution(input, signed = false) {
  assert(
    input.every((value) => Number.isFinite(value) && (signed || value >= 0)),
    "Missing, negative or non-finite measurements cannot become zero",
  );
  const values = input.toSorted((a, b) => a - b);
  if (!values.length) {
    return { count: 0, min: null, median: null, p95: null, max: null, spread: null };
  }
  const middle = values.length / 2;
  return {
    count: values.length,
    min: values[0],
    median: Number.isInteger(middle)
      ? (values[middle - 1] + values[middle]) / 2
      : values[Math.floor(middle)],
    p95: values[Math.ceil(values.length * 0.95) - 1],
    max: values.at(-1),
    spread: values.at(-1) - values[0],
  };
}

export function inspectOptInFrames(startup) {
  const callbacks = startup.frameCallbacks;
  assert(callbacks.length >= 2, "Continuous startup/warm callback observations required");
  assert([startup.sendAt, startup.warmStartAt, startup.endAt].every(finite));
  assert(
    callbacks.some((callback) => callback.warm) && callbacks.some((callback) => !callback.warm),
  );
  assert(
    callbacks.every(
      (callback) =>
        [callback.timestamp, callback.callbackAt, callback.callbackEndAt].every(finite) &&
        callback.callbackAt >= startup.sendAt &&
        callback.callbackEndAt >= callback.callbackAt &&
        callback.callbackEndAt <= startup.endAt,
    ),
  );
  const intervals = callbacks.slice(1).map((callback, index) => {
    const previous = callbacks[index];
    assert([callback.timestamp, callback.callbackAt, callback.callbackEndAt].every(finite));
    assert(callback.callbackAt >= previous.callbackAt && callback.timestamp >= previous.timestamp);
    assert(callback.callbackEndAt >= callback.callbackAt);
    return {
      at: previous.callbackAt,
      actualMs: callback.callbackAt - previous.callbackAt,
      animationTimestampMs: callback.timestamp - previous.timestamp,
      callbackLagMs: callback.callbackAt - callback.timestamp,
      previousCallbackLagMs: previous.callbackAt - previous.timestamp,
      period: previous.warm && callback.warm ? "warm" : "startup-or-boundary",
    };
  });
  intervals.unshift({
    at: startup.sendAt,
    actualMs: callbacks[0].callbackAt - startup.sendAt,
    animationTimestampMs: null,
    period: "startup-first-callback",
  });
  intervals.push({
    at: callbacks.at(-1).callbackAt,
    actualMs: startup.endAt - callbacks.at(-1).callbackAt,
    animationTimestampMs: null,
    period: "warm-end-boundary",
  });
  assert(startup.tasks.every((task) => finite(task.at) && finite(task.duration)));
  const actualTails = intervals.filter((interval) => interval.actualMs >= 50);
  const animationTimestampTails = intervals.filter(
    (interval) => interval.animationTimestampMs >= 50,
  );
  const longTasks = startup.tasks
    .filter((task) => task.duration >= 50)
    .map((task) => ({
      at: task.at,
      duration: task.duration,
      period: task.at < startup.warmStartAt ? "startup-or-boundary" : "warm",
    }));
  return { intervals, actualTails, animationTimestampTails, longTasks };
}
