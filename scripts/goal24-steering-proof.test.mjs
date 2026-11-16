import assert from "node:assert/strict";
import { test } from "node:test";
import { admit, title } from "./goal24-steering-proof.mjs";
const report = (original) => ({
  testResults: [
    {
      assertionResults: [
        "optional-human",
        "required-human",
        "optional-room",
        "optional-internal",
      ].map((name) => ({
        fullName: title + name + " steering",
        status: original && name === "optional-human" ? "failed" : "passed",
        failureMessages:
          original && name === "optional-human"
            ? [
                "AssertionError: expected [] to deeply equal [ 'oh wait, use the corrected requirements' ]\n    at /source/src/auto-reply/reply/agent-runner-steer-adoption.worker.test.ts:99:27",
              ]
            : [],
      })),
    },
  ],
});
for (const original of [false, true]) {
  test("admits exact steering outcomes " + original, () =>
    admit(report(original), original ? 1 : 0, original),
  );
}
for (const damage of [
  "zero",
  "partial",
  "duplicate",
  "nonreproduction",
  "wrong-control",
  "wrong-assertion",
  "wrong-site",
  "setup",
  "timeout",
  "exit",
]) {
  test("rejects " + damage, () => {
    const value = report(true);
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
      cases[0].status = "passed";
    }
    if (damage === "wrong-control") {
      cases[1].status = "failed";
    }
    if (damage === "wrong-assertion") {
      cases[0].failureMessages = ["expected 1 to equal 2"];
    }
    if (damage === "wrong-site") {
      cases[0].failureMessages[0] = cases[0].failureMessages[0].replace(":99:27", ":100:27");
    }
    if (damage === "setup") {
      cases[0].failureMessages.push("Failed to load module");
    }
    if (damage === "timeout") {
      cases[0].failureMessages.push("Test timed out");
    }
    assert.throws(() => admit(value, damage === "exit" ? 0 : 1, true));
  });
}
