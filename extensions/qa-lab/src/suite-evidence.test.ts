import { afterEach, describe, expect, it } from "vitest";
import { createQaEvidenceInvocation } from "./evidence-invocation.js";
import {
  getEffectiveQaEvidenceEntries,
  projectQaEvidenceScenarioOutcomes,
  type QaEvidenceIdentity,
} from "./evidence-summary.js";
import { mockBunVersion } from "./runtime-version.test-support.js";
import { createQaSuiteEvidenceInvocation } from "./suite-evidence.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const tempDirs = createTempDirHarness();
afterEach(() => tempDirs.cleanup());
const launch: QaEvidenceIdentity = {
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
  const anchors = capture
    ? undefined
    : createQaEvidenceInvocation({
        scenarios: selectedScenarios,
        channel: "qa-channel",
        launch,
      }).anchors;
  const context: Parameters<typeof createQaSuiteEvidenceInvocation>[1] = {
    outputDir,
    repoRoot: outputDir,
    selectedScenarios,
    primaryModel: "mock-openai/test",
    providerMode: "mock-openai",
    transportId: "qa-channel",
  };
  return createQaSuiteEvidenceInvocation(
    capture ? undefined : { evidenceAnchors: anchors },
    context,
  );
}

type Evidence = Awaited<ReturnType<typeof setup>>;
function effectiveStatuses(evidence: Evidence) {
  return getEffectiveQaEvidenceEntries(evidence.snapshot()).map(({ result }) => result.status);
}

describe("flow occurrence artifacts", () => {
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

  it("keeps whole-attempt selection when a retry fails", async () => {
    const evidence = await setup();
    const first = evidence.invocation.begin(0);
    await evidence.record(0, first, { name: "first", status: "fail", steps: [] });
    const second = evidence.invocation.begin(0, first);
    await evidence.record(
      0,
      second,
      { name: "second", status: "fail", steps: [] },
      { selectedId: first },
    );
    expect(evidence.snapshot().entries).toHaveLength(2);
    expect(effectiveStatuses(evidence)).toEqual(["fail"]);
    expect(
      projectQaEvidenceScenarioOutcomes(evidence.snapshot()).map(({ status: result }) => result),
    ).toEqual(["fail", null]);
  });

  it("retains a child pass beside a zero-claim parent failure", async () => {
    const evidence = await setup();
    const child = evidence.invocation.begin(0);
    await evidence.record(0, child, { name: "child", status: "pass", steps: [] });
    const parent = evidence.invocation.begin(0);
    await evidence.record(
      0,
      parent,
      { name: "parent", status: "fail", steps: [] },
      { diagnostic: true },
    );
    expect(effectiveStatuses(evidence)).toEqual(["pass", "fail"]);
    expect(evidence.snapshot().entries[1]?.coverage).toEqual([]);
    expect(projectQaEvidenceScenarioOutcomes(evidence.snapshot())[0]).toMatchObject({
      occurrenceId: parent,
      status: "fail",
    });
  });
});
