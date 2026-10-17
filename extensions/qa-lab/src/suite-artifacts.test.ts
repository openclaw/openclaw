import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createQaEvidenceInvocation } from "./evidence-invocation.js";
import {
  QA_EVIDENCE_FILENAME,
  QA_EVIDENCE_SUMMARY_KIND,
  validateQaEvidenceSummaryJson,
} from "./evidence-summary.js";
import type { QaTransportAdapter } from "./qa-transport.js";
import { writeQaSuiteArtifacts } from "./suite-artifacts.js";
import { createQaSuiteEvidenceInvocation, rebaseQaSuiteEvidence } from "./suite-evidence.js";
import { makeQaSuiteTestScenario, recordQaSuiteTestResults } from "./suite-test-helpers.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const tempDirs = createTempDirHarness();
const readJson = async (file: string): Promise<Record<string, unknown>> =>
  JSON.parse(await fs.readFile(file, "utf8"));
const expectMissing = (file: string) =>
  expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });

afterEach(() => tempDirs.cleanup());

function writeArtifacts(
  outputDir: string,
  overrides: Partial<Parameters<typeof writeQaSuiteArtifacts>[0]> = {},
) {
  return writeQaSuiteArtifacts({
    outputDir,
    startedAt: new Date("2026-04-11T00:00:00.000Z"),
    finishedAt: new Date("2026-04-11T00:01:00.000Z"),
    scenarios: [{ name: "Baseline", status: "pass", steps: [] }],
    recordedEvidence: recordQaSuiteTestResults(
      undefined,
      [makeQaSuiteTestScenario("baseline")],
      [{ name: "Baseline", status: "pass", steps: [] }],
    ).evidence,
    transport: {
      id: "qa-channel",
      createReportNotes: () => [],
    } as unknown as QaTransportAdapter,
    providerMode: "mock-openai",
    primaryModel: "mock-openai/gpt-5.6-luna",
    alternateModel: "mock-openai/gpt-5.6-luna-alt",
    fastMode: true,
    concurrency: 1,
    ...overrides,
  });
}

describe("suite artifacts", () => {
  it.each([
    { name: "default", writeEvidenceFile: undefined, status: undefined },
    { name: "memory only", writeEvidenceFile: false, status: undefined },
    { name: "running", writeEvidenceFile: undefined, status: "running" as const },
  ])("publishes $name artifacts", async ({ writeEvidenceFile, status }) => {
    const outputDir = await tempDirs.makeTempDir("qa-artifacts-");
    if (writeEvidenceFile === false) {
      await fs.writeFile(path.join(outputDir, QA_EVIDENCE_FILENAME), "stale evidence\n", "utf8");
    }
    const artifacts = await writeArtifacts(outputDir, { writeEvidenceFile, status });
    expect(artifacts.evidencePath).toBe(path.join(outputDir, QA_EVIDENCE_FILENAME));
    expect(artifacts.evidence.kind).toBe(QA_EVIDENCE_SUMMARY_KIND);
    await fs.access(artifacts.reportPath);
    expect((await readJson(artifacts.summaryPath)).evidence).toEqual(artifacts.evidence);
    if (writeEvidenceFile === false || status === "running") {
      await expectMissing(artifacts.evidencePath);
    } else {
      const evidence = await readJson(artifacts.evidencePath);
      expect(evidence.entries).toHaveLength(1);
      expect(evidence).toEqual(artifacts.evidence);
      if (process.platform !== "win32") {
        for (const file of [artifacts.reportPath, artifacts.evidencePath, artifacts.summaryPath]) {
          expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
        }
      }
    }
    if (status === "running") {
      for (const text of [
        "# OpenClaw QA Scenario Suite (In Progress)",
        "- Status: running",
        "- Updated: 2026-04-11T00:01:00.000Z",
      ]) {
        expect(artifacts.report).toContain(text);
      }
      expect(artifacts.report).not.toContain("- Finished:");
      await expect(fs.readFile(artifacts.summaryPath, "utf8")).resolves.toContain(
        '"status": "running"',
      );
      const terminal = await writeArtifacts(outputDir);
      for (const text of [
        "# OpenClaw QA Scenario Suite\n",
        "- Finished: 2026-04-11T00:01:00.000Z",
      ]) {
        expect(terminal.report).toContain(text);
      }
      for (const text of ["In Progress", "- Status: running"]) {
        expect(terminal.report).not.toContain(text);
      }
    }
  });

  it("writes the selected Crabline driver without rewriting recorded evidence", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-suite-crabline-");
    const outputDir = path.join(repoRoot, "nested");
    const scenario = {
      ...makeQaSuiteTestScenario("telegram-dm", { surface: "channel" }),
      coverage: { primary: ["channels.dm"] },
    };
    const result = {
      name: "Telegram DM",
      status: "fail" as const,
      details: "active transport does not implement this scenario",
      steps: [],
    };
    const invocation = createQaEvidenceInvocation({
      scenarios: [scenario],
      channel: "telegram",
      launch: {
        source: { ref: null, integrity: null },
        runtime: { id: null, version: null },
        package: null,
        protocol: null,
        accountRef: null,
        proofClass: null,
      },
    });
    const recorder = await createQaSuiteEvidenceInvocation(
      {
        evidenceAnchors: invocation.anchors,
        channelId: "telegram",
        channelDriver: "crabline",
        onEvidence: (snapshot) => invocation.importChild(0, snapshot),
      },
      {
        repoRoot,
        outputDir,
        primaryModel: "mock-openai/gpt-5.6-luna",
        providerMode: "mock-openai",
        selectedScenarios: [scenario],
        transportId: "qa-channel",
      },
    );
    const id = recorder.invocation.begin(0);
    await recorder.record(0, id, result);
    invocation.select(0, id);
    const recordedEvidence = recorder.snapshot();
    const before = structuredClone(recordedEvidence);
    const generation = path.join(".crabline-channel-driver-artifacts", "generation-test");
    const files: Array<[string, string]> = [
      ["channel-capability-matrix", "crabline-channel-driver-capabilities.json"],
      ["channel-driver-smoke", "crabline-provider-readiness.json"],
    ];
    const transportArtifacts = files.map(([kind, file]) => ({
      kind,
      path: path.join(generation, file),
    }));
    const artifacts = await writeArtifacts(outputDir, {
      scenarios: [result],
      recordedEvidence,
      channel: "telegram",
      channelDriver: "crabline",
      transportArtifacts: {
        artifacts: structuredClone(transportArtifacts),
        reportNotes: ["Transport-owned artifact evidence captured."],
      },
    });

    expect((await readJson(artifacts.summaryPath)).run).toMatchObject({
      channelCapabilityMatrixPath: transportArtifacts[0]!.path,
      channelDriverSmokePath: transportArtifacts[1]!.path,
    });
    for (const artifact of transportArtifacts) {
      await expectMissing(path.join(outputDir, path.basename(artifact.path)));
    }
    const parsed = validateQaEvidenceSummaryJson(await readJson(artifacts.evidencePath));
    if (parsed.schemaVersion !== 3) {
      throw new Error("expected recorded occurrences");
    }
    expect(parsed).toEqual(before);
    invocation.importChild(0, parsed);
    expect(recordedEvidence).toEqual(before);
    expect(parsed.occurrences.flatMap((occurrence) => occurrence.receipts)).toHaveLength(1);
    const rebased = rebaseQaSuiteEvidence(parsed, outputDir, path.dirname(outputDir));
    expect(rebased.entries[0]?.execution?.artifacts).toEqual(
      parsed.entries[0]?.execution?.artifacts.map((artifact) =>
        Object.assign({}, artifact, {
          path: `${path.basename(outputDir)}/${artifact.path}`,
        }),
      ),
    );
    expect(parsed.entries[0]).toMatchObject({
      execution: { channel: { driver: "crabline", id: "telegram" } },
      result: {
        failure: { reason: "active transport does not implement this scenario" },
        status: "fail",
      },
    });
  });
});
