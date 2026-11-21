import { afterEach, expect, it } from "vitest";
import { createQaEvidenceInvocation } from "./evidence-invocation.js";
import {
  getEffectiveQaEvidenceEntries,
  projectQaEvidenceScenarioOutcomes,
} from "./evidence-summary.js";
import { mockBunVersion } from "./runtime-version.test-support.js";
import { createQaSuiteEvidenceInvocation } from "./suite-evidence.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const tempDirs = createTempDirHarness();
afterEach(() => tempDirs.cleanup());
const launch: Parameters<typeof createQaEvidenceInvocation>[0]["launch"] = {
  source: { ref: "fixture-source", integrity: "fixture-integrity" },
  runtime: { id: "node", version: "fixture-version" },
  package: null,
  protocol: null,
  accountRef: null,
  proofClass: "fixture-only",
};

async function setup(capture = false) {
  const outputDir = await tempDirs.makeTempDir("qa-flow-occurrences-");
  const scenario = makeQaSuiteTestScenario(capture ? "captured" : "same-label");
  const selectedScenarios = capture ? [scenario] : [scenario, scenario];
  const params = capture
    ? undefined
    : {
        evidenceAnchors: createQaEvidenceInvocation({
          scenarios: selectedScenarios,
          channel: "qa-channel",
          launch,
        }).anchors,
      };
  return createQaSuiteEvidenceInvocation(params, {
    outputDir,
    repoRoot: outputDir,
    selectedScenarios,
    primaryModel: "mock-openai/test",
    providerMode: "mock-openai",
    transportId: "qa-channel",
  });
}

it("carries simulated Bun capture into prepared receipts", async () => {
  using _ = mockBunVersion("1.3.14");
  const evidence = await setup(true);
  const id = evidence.invocation.begin(0);
  await evidence.record(0, id, { name: "captured", status: "pass", steps: [] });
  const occurrence = evidence.snapshot().occurrences.find((item) => item.id === id)!;
  expect(occurrence.launch.runtime).toEqual({ id: "bun", version: "1.3.14" });
  expect(occurrence.receipts).toEqual([
    expect.objectContaining({ phase: "prepared", identity: occurrence.launch }),
  ]);
});

it.each([
  ["retry", "fail", ["fail"]],
  ["diagnostic", "pass", ["pass", "fail"]],
] as const)("keeps whole-attempt evidence for a %s failure", async (kind, status, expected) => {
  const evidence = await setup();
  const first = evidence.invocation.begin(0);
  await evidence.record(0, first, { name: "first", status, steps: [] });
  const second = evidence.invocation.begin(0, kind === "retry" ? first : undefined);
  await evidence.record(
    0,
    second,
    { name: "second", status: "fail", steps: [] },
    kind === "retry" ? { selectedId: first } : { diagnostic: true },
  );
  const snapshot = evidence.snapshot();
  const outcomes = projectQaEvidenceScenarioOutcomes(snapshot);
  expect(snapshot.entries).toHaveLength(2);
  expect(getEffectiveQaEvidenceEntries(snapshot).map(({ result }) => result.status)).toEqual(
    expected,
  );
  expect(outcomes.map((outcome) => outcome.status)).toEqual(["fail", null]);
  if (kind === "diagnostic") {
    expect(snapshot.entries[1]?.coverage).toEqual([]);
    expect(outcomes[0]).toMatchObject({ occurrenceId: second, status: "fail" });
  }
});
