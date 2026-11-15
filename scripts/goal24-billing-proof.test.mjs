// Exercise evidence admission only; no contributor modules execute locally.
import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, plans, withSequencer } from "./goal24-billing-proof-plan.mjs";
const plan = plans.compaction;
for (const scenario of [
  "pass",
  "signature",
  "different-failure",
  "zero",
  "skipped",
  "missing",
  "exit-disagreement",
]) {
  test("billing evidence admission: " + scenario, () => {
    const assertion = { fullName: plan.required[0], status: "passed", failureMessages: [] };
    let code = 0;
    if (["signature", "different-failure"].includes(scenario)) {
      assertion.status = "failed";
      assertion.failureMessages = [
        scenario === "signature"
          ? "Compaction ended before the backend entered"
          : "different failure",
      ];
      code = 1;
    }
    if (scenario === "skipped") {
      assertion.status = "pending";
    }
    if (scenario === "missing") {
      assertion.fullName = "unrelated case";
    }
    if (scenario === "exit-disagreement") {
      code = 1;
    }
    const report = {
      testResults: [
        {
          name: plan.files[0],
          startTime: 1,
          assertionResults: scenario === "zero" ? [] : [assertion],
        },
      ],
    };
    if (["zero", "skipped", "missing", "exit-disagreement"].includes(scenario)) {
      assert.throws(() => classify(plan, report, code));
    } else {
      const result = classify(plan, report, code);
      assert.equal(result.outcome, scenario === "pass" ? "not-reproduced" : "failed");
      if (code) {
        assert.equal(result.failures[0].originalSignature, scenario === "signature");
      }
    }
  });
}
for (const reversed of [false, true]) {
  test("billing file start ordering: reversed=" + reversed, () => {
    const selected = plans.startup;
    const report = {
      testResults: selected.files.map((name, index) => ({
        name,
        startTime: reversed ? 2 - index : index + 1,
        assertionResults: [
          { fullName: selected.required[index], status: "passed", failureMessages: [] },
        ],
      })),
    };
    if (reversed) {
      assert.throws(() => classify(selected, report, 0), /file order changed/);
    } else {
      assert.equal(classify(selected, report, 0).executed, 2);
    }
  });
}
test("matching message from a different runtime is not original signature", () => {
  const report = {
    testResults: [
      {
        name: plan.files[0],
        startTime: 1,
        assertionResults: [
          {
            fullName: plan.required[0],
            status: "failed",
            failureMessages: ["Compaction ended before the backend entered"],
          },
        ],
      },
    ],
  };
  assert.equal(classify(plan, report, 1, "bun").failures[0].originalSignature, false);
});
test("sessions.create wrapper preserves Error timeout signature", () => {
  const name = "public required sessions.create publishes";
  const selected = {
    files: ["fixture.test.ts"],
    required: [name],
    signatures: { [name]: plans.state.signatures[name] },
  };
  const report = {
    testResults: [
      {
        name: "fixture.test.ts",
        startTime: 1,
        assertionResults: [
          {
            fullName: name,
            status: "failed",
            failureMessages: ["Gateway test RPC sessions.create: Error: timeout"],
          },
        ],
      },
    ],
  };
  assert.equal(classify(selected, report, 1).failures[0].originalSignature, true);
});

test("sequencer config carries a constructor, preserving original policies", async () => {
  const source = withSequencer(
    'export default { test: { pool: "forks", sequence: { groupOrder: 2 } } };',
  );
  const fixture = source.replace(
    'import Goal24Sequencer from "./goal24-billing-sequencer.mjs";',
    "class Goal24Sequencer {}",
  );
  const { default: config } = await import("data:text/javascript," + encodeURIComponent(fixture));
  assert.equal(typeof config.test.sequence.sequencer, "function");
  assert.ok(new config.test.sequence.sequencer());
  assert.equal(config.test.sequence.groupOrder, 2);
  assert.equal(config.test.pool, "forks");
  assert.throws(() => withSequencer("const config = {};"));
});
