import assert from "node:assert/strict";
import { test } from "node:test";
import { admit, wireName, ownerName } from "./goal24-matrix-proof.mjs";
const report = (kind, original) => ({
  testResults: [
    {
      assertionResults: [false, true].map((flag) => ({
        fullName: "suite " + (kind === "wire" ? wireName : ownerName) + flag,
        status: original && (kind === "wire" ? !flag : flag) ? "failed" : "passed",
        failureMessages: [
          kind === "wire"
            ? "AssertionError: expected M_FORBIDDEN: MatrixError: [403] Cannot send to room to match { retryable: false }"
            : "MatrixError: [403] M_FORBIDDEN",
        ],
      })),
    },
  ],
});
for (const kind of ["wire", "owner"]) {
  for (const original of [false, true]) {
    test(kind + " admits exact differential " + original, () =>
      admit(report(kind, original), original ? 1 : 0, kind, original),
    );
  }
  for (const damage of [
    "zero",
    "partial",
    "duplicate",
    "nonreproduction",
    "setup",
    "timeout",
    "connection",
    "exit",
  ]) {
    test(kind + " rejects " + damage, () => {
      const value = report(kind, true);
      const cases = value.testResults[0].assertionResults;
      if (damage === "zero") {
        cases.length = 0;
      }
      if (damage === "partial") {
        cases.pop();
      }
      if (damage === "duplicate") {
        cases[1] = cases[0];
      }
      if (damage === "nonreproduction") {
        cases.forEach((entry) => (entry.status = "passed"));
      }
      if (damage === "setup") {
        cases.find((entry) => entry.status === "failed").failureMessages = ["Cannot find module"];
      }
      if (damage === "timeout") {
        cases.find((entry) => entry.status === "failed").failureMessages.push("Timeout");
      }
      if (damage === "connection") {
        cases.find((entry) => entry.status === "failed").failureMessages = [
          "AssertionError: expected Error: connect ECONNREFUSED 127.0.0.1 to match object { retryable: false }",
        ];
      }
      assert.throws(() => admit(value, damage === "exit" ? 0 : 1, kind, true));
    });
  }
}
test("rejects partial pinned suite", () =>
  assert.throws(() => admit(report("wire", false), 0, "sdk")));
