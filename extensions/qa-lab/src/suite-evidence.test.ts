import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createQaEvidenceInvocation } from "./evidence-invocation.js";
import {
  getEffectiveQaEvidenceEntries,
  projectQaEvidenceScenarioOutcomes,
  validateQaEvidenceSummaryJson,
  type QaEvidenceIdentity,
} from "./evidence-summary.js";
import { mockBunVersion } from "./runtime-version.test-support.js";
import { createQaSuiteEvidenceInvocation, rebaseQaSuiteEvidence } from "./suite-evidence.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const tempDirs = createTempDirHarness();
afterEach(async () => {
  await tempDirs.cleanup();
});
const launch: QaEvidenceIdentity = {
  source: { ref: "fixture-source", integrity: "fixture-integrity" },
  runtime: { id: "node", version: "fixture-version" },
  package: null,
  protocol: null,
  accountRef: null,
  proofClass: "fixture-only",
};

async function setup() {
  const outputDir = await tempDirs.makeTempDir("qa-flow-occurrences-");
  const scenario = makeQaSuiteTestScenario("same-label");
  const selectedScenarios = [scenario, scenario];
  const parent = createQaEvidenceInvocation({
    scenarios: selectedScenarios,
    channel: "qa-channel",
    launch,
  });
  const evidence = await createQaSuiteEvidenceInvocation(
    { evidenceAnchors: parent.anchors },
    {
      outputDir,
      repoRoot: outputDir,
      selectedScenarios,
      primaryModel: "mock-openai/test",
      providerMode: "mock-openai",
      transportId: "qa-channel",
    },
  );
  return { outputDir, evidence };
}

describe("flow occurrence artifacts", () => {
  it("carries simulated Bun capture into prepared receipts and preserves explicit anchors", async () => {
    using _ = mockBunVersion("1.3.14");
    const outputDir = await tempDirs.makeTempDir("qa-captured-launch-");
    const evidence = await createQaSuiteEvidenceInvocation(undefined, {
      repoRoot: outputDir,
      outputDir,
      selectedScenarios: [makeQaSuiteTestScenario("captured")],
      primaryModel: "mock-openai/test",
      providerMode: "mock-openai",
      transportId: "qa-channel",
    });
    const id = evidence.invocation.begin(0);
    await evidence.record(0, id, { name: "captured", status: "pass", steps: [] });
    const occurrence = evidence.snapshot().occurrences.find((item) => item.id === id)!;
    expect(occurrence.launch.runtime).toEqual({ id: "bun", version: "1.3.14" });
    expect(occurrence.receipts).toEqual([
      expect.objectContaining({ phase: "prepared", identity: occurrence.launch }),
    ]);

    const supplied = await setup();
    const explicitId = supplied.evidence.invocation.begin(0);
    await supplied.evidence.record(0, explicitId, { name: "explicit", status: "pass", steps: [] });
    const explicit = supplied.evidence
      .snapshot()
      .occurrences.find((item) => item.id === explicitId)!;
    expect(explicit.launch).toEqual(launch);
    expect(explicit.receipts[0]?.identity).toEqual(launch);
  });

  it.each(["full", "slim"] as const)(
    "round-trips parent-relative %s history without changing paths, hashes or input",
    async (evidenceMode) => {
      const { outputDir, evidence } = await setup();
      const id = evidence.invocation.begin(0);
      await evidence.record(0, id, { name: "parent", status: "fail", steps: [] });
      const summary = evidence.invocation.snapshot({
        generatedAt: "2026-09-14T00:00:00.000Z",
        evidenceMode,
      });
      const occurrence = summary.occurrences.find((item) => item.id === id)!;
      const receipt = occurrence.receipts[0]!;
      const preserved = [
        { ...receipt.artifact, path: path.join(outputDir, "absolute.json") },
        { ...receipt.artifact, path: "<repo-root>/artifacts/pinned.json" },
        { ...receipt.artifact, path: "../producer.json", source: "script-producer" },
      ];
      occurrence.receipts.push(
        ...preserved.map((artifact, index) => ({
          ...receipt,
          id: `${id}:preserved-${index}`,
          artifact,
        })),
      );
      summary.entries[0]?.execution?.artifacts.push(
        ...preserved.map(({ kind, path: artifactPath, source }) => ({
          kind,
          path: artifactPath,
          source,
        })),
      );
      const original = validateQaEvidenceSummaryJson(summary);
      const before = JSON.stringify(original);
      const workerDir = path.join(outputDir, "scenarios", "worker");
      const child = rebaseQaSuiteEvidence(original, outputDir, workerDir);
      if (child.schemaVersion !== 3) {
        throw new Error("expected v3 history");
      }
      const childReceipts = child.occurrences.find((item) => item.id === id)!.receipts;
      expect(childReceipts[0]!.artifact.path).toBe(`../../${receipt.artifact.path}`);
      expect(childReceipts.slice(1).map((item) => item.artifact)).toEqual(preserved);
      expect(rebaseQaSuiteEvidence(child, workerDir, outputDir)).toEqual(original);
      expect(JSON.stringify(original)).toBe(before);
      expect(child.entries[0]?.execution === undefined).toBe(evidenceMode === "slim");
      const bytes = await fs.readFile(path.join(outputDir, receipt.artifact.path));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(receipt.artifact.sha256);
    },
  );

  it("returns the original failed result when a continued retry skips", async () => {
    const { outputDir, evidence } = await setup();
    const first = evidence.invocation.begin(0);
    const failure = {
      name: "original",
      status: "fail" as const,
      details: "original diagnostic",
      steps: [{ name: "original step", status: "fail" as const, details: "original detail" }],
    };
    const original = await evidence.record(0, first, failure);
    const scenario = makeQaSuiteTestScenario("same-label");
    const continued = await createQaSuiteEvidenceInvocation(
      { evidenceAnchors: evidence.invocation.anchors, evidenceContinuation: evidence.snapshot() },
      {
        outputDir,
        repoRoot: outputDir,
        selectedScenarios: [scenario, scenario],
        primaryModel: "mock-openai/test",
        providerMode: "mock-openai",
        transportId: "qa-channel",
      },
    );
    const retry = continued.invocation.begin(0);
    expect(await continued.record(0, retry, { name: "retry", status: "skip", steps: [] })).toEqual(
      original,
    );
    expect(projectQaEvidenceScenarioOutcomes(continued.snapshot())[0]).toMatchObject({
      occurrenceId: first,
      status: "fail",
    });
    expect(continued.snapshot().entries.map((row) => row.result.status)).toEqual([
      "fail",
      "skipped",
    ]);
  });

  it("retains same-label attempts in exclusive artifacts with verifiable receipts", async () => {
    const { outputDir, evidence } = await setup();
    for (const index of [0, 1]) {
      const id = evidence.invocation.begin(index);
      await evidence.record(index, id, { name: "same-label", status: "pass", steps: [] });
    }
    const summary = evidence.snapshot();
    expect(projectQaEvidenceScenarioOutcomes(summary).map(({ status }) => status)).toEqual([
      "pass",
      "pass",
    ]);
    const paths = [];
    for (const occurrence of summary.occurrences.filter(
      ({ scenario }) => scenario?.kind === "observation",
    )) {
      const receipt = occurrence.receipts[0]!;
      const bytes = await fs.readFile(path.join(outputDir, receipt.artifact.path));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(receipt.artifact.sha256);
      expect(receipt.identity).toEqual(launch);
      expect(JSON.parse(bytes.toString()).result.evidenceOccurrenceId).toBe(occurrence.id);
      paths.push(receipt.artifact.path);
    }
    expect(new Set(paths).size).toBe(2);
    const first = summary.entries[0]!.binding.occurrenceId;
    await expect(
      evidence.record(0, first, { name: "overwrite", status: "fail", steps: [] }),
    ).rejects.toMatchObject({ code: "publication_failed", cause: { code: "EEXIST" } });
    expect(evidence.snapshot()).toMatchObject({ entries: summary.entries });
  });

  it.each(["occurrence", "producer"] as const)(
    "classifies exclusive %s publication failure without changing completed evidence",
    async (kind) => {
      const { outputDir, evidence } = await setup();
      const first = evidence.invocation.begin(0);
      await evidence.record(0, first, { name: "completed", status: "pass", steps: [] });
      const before = evidence.snapshot();
      const receipt = before.occurrences.find((item) => item.id === first)!.receipts[0]!;
      const original = await fs.readFile(path.join(outputDir, receipt.artifact.path));
      const next = evidence.invocation.begin(1);
      const blocked = path.join(
        outputDir,
        "artifacts/occurrences",
        `${next}${kind === "producer" ? ".producer-evidence" : ""}.json`,
      );
      await fs.writeFile(blocked, "reserved bytes");
      await expect(
        evidence.record(
          1,
          next,
          { name: "unpublished", status: "pass", steps: [] },
          kind === "producer" ? { childEvidence: before } : {},
        ),
      ).rejects.toMatchObject({ code: "publication_failed", cause: { code: "EEXIST" } });
      expect(await fs.readFile(blocked, "utf8")).toBe("reserved bytes");
      const retained = await fs.readFile(path.join(outputDir, receipt.artifact.path));
      expect(retained).toEqual(original);
      expect(createHash("sha256").update(retained).digest("hex")).toBe(receipt.artifact.sha256);
      expect(evidence.snapshot().entries).toEqual(before.entries);
    },
  );

  it("rebases raw and receipt artifacts together without changing their identity", async () => {
    const { outputDir, evidence } = await setup();
    const id = evidence.invocation.begin(0);
    await evidence.record(0, id, { name: "child", status: "pass", steps: [] });
    const summary = evidence.snapshot();
    const parent = rebaseQaSuiteEvidence(summary, outputDir, path.dirname(outputDir));
    expect(parent.schemaVersion).toBe(3);
    if (parent.schemaVersion !== 3) {
      throw new Error("expected occurrence evidence");
    }
    const before = summary.occurrences.find((occurrence) => occurrence.id === id)!.receipts[0]!;
    const after = parent.occurrences.find((occurrence) => occurrence.id === id)!.receipts[0]!;
    expect(after).toEqual({
      ...before,
      artifact: { ...before.artifact, path: `${path.basename(outputDir)}/${before.artifact.path}` },
    });
    expect(parent.entries[0]?.execution?.artifacts[0]?.path).toBe(after.artifact.path);
    expect(summary.occurrences.find((occurrence) => occurrence.id === id)!.receipts[0]).toEqual(
      before,
    );
  });

  it.each(["pass", "fail"] as const)(
    "keeps whole-attempt selection when a retry is %s",
    async (status) => {
      const { evidence } = await setup();
      const first = evidence.invocation.begin(0);
      await evidence.record(0, first, { name: "first", status: "fail", steps: [] });
      const second = evidence.invocation.begin(0, first);
      await evidence.record(
        0,
        second,
        { name: "second", status, steps: [] },
        {
          selectedId: status === "pass" ? second : first,
        },
      );
      expect(evidence.snapshot().entries).toHaveLength(2);
      expect(
        getEffectiveQaEvidenceEntries(evidence.snapshot()).map(({ result }) => result.status),
      ).toEqual([status]);
      expect(
        projectQaEvidenceScenarioOutcomes(evidence.snapshot()).map(({ status: result }) => result),
      ).toEqual([status, null]);
    },
  );

  it("retains a child pass beside a zero-claim parent failure", async () => {
    const { evidence } = await setup();
    const child = evidence.invocation.begin(0);
    await evidence.record(0, child, { name: "child", status: "pass", steps: [] });
    const parent = evidence.invocation.begin(0);
    await evidence.record(
      0,
      parent,
      { name: "parent", status: "fail", steps: [] },
      { diagnostic: true },
    );
    expect(
      getEffectiveQaEvidenceEntries(evidence.snapshot()).map(({ result }) => result.status),
    ).toEqual(["pass", "fail"]);
    expect(evidence.snapshot().entries[1]?.coverage).toEqual([]);
    expect(projectQaEvidenceScenarioOutcomes(evidence.snapshot())[0]).toMatchObject({
      occurrenceId: parent,
      status: "fail",
    });
  });
});
