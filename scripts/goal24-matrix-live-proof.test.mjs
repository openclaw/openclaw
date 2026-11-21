import assert from "node:assert/strict";
import { test } from "node:test";
import { admitLive, requiredCases } from "./goal24-matrix-live-proof.mjs";
const report = () => ({
  testResults: [
    { assertionResults: requiredCases.map((title) => ({ title, status: "passed", duration: 1 })) },
  ],
});
test("admits exactly the three completed live boundaries", () =>
  assert.equal(admitLive(report()).length, 3));
for (const mutation of ["zero", "partial", "duplicate", "failed", "skipped"]) {
  test("rejects " + mutation + " live evidence", () => {
    const value = report();
    const cases = value.testResults[0].assertionResults;
    if (mutation === "zero") {
      cases.length = 0;
    }
    if (mutation === "partial") {
      cases.pop();
    }
    if (mutation === "duplicate") {
      cases[2].title = cases[0].title;
    }
    if (mutation === "failed" || mutation === "skipped") {
      cases[0].status = mutation;
    }
    assert.throws(() => admitLive(value));
  });
}
