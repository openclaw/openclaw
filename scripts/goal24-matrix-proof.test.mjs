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
            ? "Error: expected M_FORBIDDEN: MatrixError: [403] Cannot se… { …(7) } to match object { retryable: false, …(1) }\n    at /source/extensions/matrix/src/matrix/sdk/transport.test.ts:154:35"
            : "OutboundDeliveryError: message failed: MatrixError: [403] M_FORBIDDEN\n    at /source/src/agents/tools/message-tool-execution.test.ts:457:21\n    at runWithTimeout (/vitest.js:3276:10)",
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
test("accepts repeated parameterized titles in complete SDK suite", () => {
  const value = {
    testResults: [
      {
        assertionResults: Array.from({ length: 97 }, () => ({
          fullName: "parameterized title",
          status: "passed",
          failureMessages: [],
        })),
      },
    ],
  };
  assert.equal(admit(value, 0, "sdk").length, 97);
});
test("rejects partial pinned suite", () =>
  assert.throws(() => admit(report("wire", false), 0, "sdk")));

for (const { name, mutate } of [
  { name: "wrong assertion", mutate: (value) => value.replace(":154:35", ":155:35") },
  { name: "wrong error", mutate: (value) => value.replace("M_FORBIDDEN", "M_UNKNOWN") },
  {
    name: "wrong expectation",
    mutate: (value) => value.replace("retryable: false", "retryable: true"),
  },
  { name: "unrelated truncation", mutate: (value) => value.replace("Cannot se…", "Cannot re…") },
]) {
  test("wire rejects " + name, () => {
    const value = report("wire", true);
    const failed = value.testResults[0].assertionResults[0];
    failed.failureMessages = failed.failureMessages.map(mutate);
    assert.throws(() => admit(value, 1, "wire", true));
  });
}
