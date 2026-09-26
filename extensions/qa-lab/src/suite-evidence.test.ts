import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import type { QaSuiteRunParams } from "./suite-types.js";
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

async function setup(
  params: Pick<QaSuiteRunParams, "onEvidence" | "onScenarioStarted"> = {},
  onResultCommitted?: Parameters<typeof createQaSuiteEvidenceInvocation>[2],
) {
  const outputDir = await tempDirs.makeTempDir("qa-flow-occurrences-");
  const scenario = makeQaSuiteTestScenario("same-label");
  const selectedScenarios = [scenario, scenario];
  const parent = createQaEvidenceInvocation({
    scenarios: selectedScenarios,
    channel: "qa-channel",
    launch,
  });
  const context = {
    outputDir,
    repoRoot: outputDir,
    selectedScenarios,
    primaryModel: "mock-openai/test",
    providerMode: "mock-openai" as const,
    transportId: "qa-channel" as const,
  };
  const evidence = await createQaSuiteEvidenceInvocation(
    { ...params, evidenceAnchors: parent.anchors },
    context,
    onResultCommitted,
  );
  return { outputDir, evidence, context };
}

describe("flow occurrence artifacts", () => {
  it.each(["pass", "fail"] as const)(
    "commits a selected %s before its evidence observer throws",
    async (status) => {
      const publicationError = new Error("evidence observer failed");
      const committed = vi.fn();
      const { evidence } = await setup(
        {
          onEvidence(summary) {
            if (summary.entries.length > 0) {
              expect(committed).toHaveBeenCalledOnce();
              throw publicationError;
            }
          },
        },
        committed,
      );
      expect(committed).not.toHaveBeenCalled();
      const id = evidence.invocation.begin(0);
      await expect(evidence.record(0, id, { name: "selected", status, steps: [] })).rejects.toBe(
        publicationError,
      );
      expect(committed).toHaveBeenCalledExactlyOnceWith(0, {
        name: "selected",
        status,
        steps: [],
        evidenceOccurrenceId: id,
      });
      expect(projectQaEvidenceScenarioOutcomes(evidence.snapshot())[0]).toMatchObject({
        occurrenceId: id,
        status,
      });
    },
  );

  it("finalizes only an interrupted unresolved instance without rewriting retry history", async () => {
    const committed = vi.fn();
    const started = vi.fn();
    const { evidence } = await setup({ onScenarioStarted: started }, committed);
    evidence.markStarted(0);
    const first = evidence.invocation.begin(0);
    await evidence.record(0, first, { name: "first", status: "fail", steps: [] });
    evidence.markStarted(0);
    const retry = evidence.invocation.begin(0);
    await evidence.record(0, retry, { name: "retry", status: "pass", steps: [] });
    const before = evidence.snapshot();
    committed.mockClear();

    await evidence.finalizeInterrupted("suite cancelled: interrupted");

    const after = evidence.snapshot();
    expect(after.entries.slice(0, before.entries.length)).toEqual(before.entries);
    for (const occurrence of before.occurrences.filter(
      (item) => item.id !== evidence.invocation.anchors[1]!.id,
    )) {
      expect(after.occurrences.find(({ id }) => id === occurrence.id)).toEqual(occurrence);
    }
    const outcomes = projectQaEvidenceScenarioOutcomes(after);
    expect(outcomes.map(({ status }) => status)).toEqual(["pass", "fail"]);
    expect(outcomes[0]?.occurrenceId).toBe(retry);
    expect(committed).toHaveBeenCalledExactlyOnceWith(
      1,
      expect.objectContaining({
        status: "fail",
        details: "suite cancelled: interrupted",
      }),
    );
    expect(after.entries.at(-1)).toMatchObject({
      coverage: [],
      binding: { occurrenceId: outcomes[1]?.occurrenceId, assertionId: null },
      result: { status: "fail" },
    });
    expect(
      after.occurrences.find(({ id }) => id === outcomes[1]?.occurrenceId)?.assertions,
    ).toBeNull();
    await evidence.finalizeInterrupted("suite cancelled: repeated publication");
    expect(evidence.snapshot().occurrences).toEqual(after.occurrences);
    expect(committed).toHaveBeenCalledOnce();
    expect(started).toHaveBeenCalledExactlyOnceWith(evidence.invocation.anchors[0]!.id);
    expect(evidence.startedScenarios()).toEqual({
      startedScenarioIds: ["same-label"],
      startedScenarioInstanceIds: [evidence.invocation.anchors[0]!.id],
    });
  });

  it.each([1, 2])(
    "restores %i continued same-label results before finalizing an interruption",
    async (retainedCount) => {
      const { outputDir, evidence, context } = await setup();
      const retained = [];
      for (let index = 0; index < retainedCount; index++) {
        const id = evidence.invocation.begin(index);
        retained.push(
          await evidence.record(index, id, {
            name: "same-label",
            status: index === 0 ? "pass" : "fail",
            details: `retained result ${index}`,
            steps: [],
          }),
        );
      }
      const before = evidence.snapshot();
      const artifacts = before.occurrences.flatMap(({ receipts }) =>
        receipts.map(({ artifact }) => path.join(outputDir, artifact.path)),
      );
      const bytes = await Promise.all(artifacts.map((file) => fs.readFile(file)));
      const committed = vi.fn();
      const started = vi.fn();
      const continued = await createQaSuiteEvidenceInvocation(
        {
          evidenceAnchors: evidence.invocation.anchors,
          evidenceContinuation: before,
          onScenarioStarted: started,
        },
        context,
        committed,
      );
      expect(committed).not.toHaveBeenCalled();

      await continued.finalizeInterrupted("suite cancelled during continuation startup");

      expect(committed).toHaveBeenCalledTimes(2);
      for (const [index, result] of retained.entries()) {
        expect(committed).toHaveBeenNthCalledWith(index + 1, index, result);
      }
      const after = continued.snapshot();
      expect(after.entries.slice(0, before.entries.length)).toEqual(before.entries);
      expect(
        projectQaEvidenceScenarioOutcomes(after)
          .slice(0, retainedCount)
          .map(({ occurrenceId }) => occurrenceId),
      ).toEqual(retained.map(({ evidenceOccurrenceId }) => evidenceOccurrenceId));
      expect(await Promise.all(artifacts.map((file) => fs.readFile(file)))).toEqual(bytes);
      await continued.finalizeInterrupted("repeated finalization");
      expect(continued.snapshot().occurrences).toEqual(after.occurrences);
      expect(committed).toHaveBeenCalledTimes(2);
      expect(started).not.toHaveBeenCalled();
      expect(continued.startedScenarios()).toEqual({
        startedScenarioIds: [],
        startedScenarioInstanceIds: [],
      });
    },
  );

  it("rejects a changed continued artifact before handing its result to reporting", async () => {
    const { outputDir, evidence, context } = await setup();
    const id = evidence.invocation.begin(0);
    await evidence.record(0, id, { name: "original", status: "pass", steps: [] });
    const before = evidence.snapshot();
    const artifact = before.occurrences.find((item) => item.id === id)!.receipts[0]!.artifact;
    await fs.appendFile(path.join(outputDir, artifact.path), "changed");
    const committed = vi.fn();
    const continued = await createQaSuiteEvidenceInvocation(
      { evidenceAnchors: evidence.invocation.anchors, evidenceContinuation: before },
      context,
      committed,
    );

    await expect(continued.finalizeInterrupted("suite cancelled")).rejects.toThrow(
      "selected flow result artifact changed",
    );

    expect(committed).not.toHaveBeenCalled();
    expect(continued.snapshot().occurrences).toEqual(before.occurrences);
    expect(continued.snapshot().entries).toEqual(before.entries);
  });

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

  it.each([false, true])(
    "commits the original failed result when a continued retry skips (observer throws=%s)",
    async (observerThrows) => {
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
      const publicationError = new Error("retry evidence observer failed");
      const committed = vi.fn();
      const continued = await createQaSuiteEvidenceInvocation(
        {
          evidenceAnchors: evidence.invocation.anchors,
          evidenceContinuation: evidence.snapshot(),
          onEvidence(summary) {
            if (observerThrows && summary.entries.length > 1) {
              expect(committed).toHaveBeenCalledExactlyOnceWith(0, original);
              throw publicationError;
            }
          },
        },
        {
          outputDir,
          repoRoot: outputDir,
          selectedScenarios: [scenario, scenario],
          primaryModel: "mock-openai/test",
          providerMode: "mock-openai",
          transportId: "qa-channel",
        },
        committed,
      );
      const retry = continued.invocation.begin(0);
      const record = continued.record(0, retry, { name: "retry", status: "skip", steps: [] });
      if (observerThrows) {
        await expect(record).rejects.toBe(publicationError);
      } else {
        await expect(record).resolves.toEqual(original);
      }
      expect(committed).toHaveBeenCalledExactlyOnceWith(0, original);
      expect(projectQaEvidenceScenarioOutcomes(continued.snapshot())[0]).toMatchObject({
        occurrenceId: first,
        status: "fail",
      });
      expect(continued.snapshot().entries.map((row) => row.result.status)).toEqual([
        "fail",
        "skipped",
      ]);
    },
  );

  it("commits the imported child selection before publishing its dispatch", async () => {
    const committed = vi.fn();
    const publicationError = new Error("parent evidence observer failed");
    const { evidence, outputDir } = await setup(
      {
        onEvidence(summary) {
          if (summary.entries.length > 0) {
            expect(committed).toHaveBeenCalledOnce();
            throw publicationError;
          }
        },
      },
      committed,
    );
    const dispatchId = evidence.invocation.begin(0, null, { diagnostic: true });
    const childDir = path.join(outputDir, "child");
    const child = await createQaSuiteEvidenceInvocation(
      {
        evidenceAnchors: [evidence.invocation.anchors[0]!],
        evidenceContinuation: evidence.invocation.childInput(0),
      },
      {
        repoRoot: outputDir,
        outputDir: childDir,
        selectedScenarios: [makeQaSuiteTestScenario("same-label")],
        primaryModel: "mock-openai/test",
        providerMode: "mock-openai",
        transportId: "qa-channel",
      },
    );
    const childId = child.invocation.begin(0);
    const childResult = await child.record(0, childId, {
      name: "child",
      status: "pass",
      steps: [],
    });
    evidence.invocation.importChild(
      0,
      rebaseQaSuiteEvidence(child.snapshot(), childDir, outputDir),
    );
    await expect(
      evidence.record(0, dispatchId, childResult, { selectedId: childId, importedEntries: [] }),
    ).rejects.toBe(publicationError);
    expect(committed).toHaveBeenCalledExactlyOnceWith(0, childResult);
    expect(projectQaEvidenceScenarioOutcomes(evidence.snapshot())[0]).toMatchObject({
      occurrenceId: childId,
      status: "pass",
    });
  });

  it("retains same-label attempts in exclusive artifacts with verifiable receipts", async () => {
    const committed = vi.fn();
    const { outputDir, evidence } = await setup({}, committed);
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
    committed.mockClear();
    await expect(
      evidence.record(0, first, { name: "overwrite", status: "fail", steps: [] }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(committed).not.toHaveBeenCalled();
    expect(evidence.snapshot()).toMatchObject({ entries: summary.entries });
  });

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
