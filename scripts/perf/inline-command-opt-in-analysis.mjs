// Shared measurement facts; callers supply comparison identities and acceptance policy.
import assert from "node:assert/strict";
import { isAbsolute } from "node:path";

const controlSource = "454004eab143e6bb25ee95f905fa650173e0c4a4";
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
