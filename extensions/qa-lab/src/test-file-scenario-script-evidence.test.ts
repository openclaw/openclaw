import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { resolveQaArtifactPath } from "./cli-paths.js";
import { buildQaOccurrenceEvidenceSummary, type QaEvidenceOccurrence } from "./evidence-summary.js";
import { runQaTestFileScenarios } from "./test-file-scenario-runner.js";
import {
  buildScriptProducerEvidence,
  makeTestFileScenario,
  QA_TEST_RUNNER_DEFAULTS,
  writeNativeVitestReport,
} from "./test-file-scenario-runner.test-support.js";
import { readScriptProducerEvidence } from "./test-file-scenario-script-evidence.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("script evidence reader", () => {
  it.each(["full", "slim"] as const)(
    "rebases receipt artifacts without changing %s source evidence",
    async (evidenceMode) => {
      const repoRoot = tempDirs.make("qa-script-receipt-");
      const outputDir = path.join(repoRoot, "output");
      const scenario = { id: "owned-scenario" };
      const evidenceDir = path.join(outputDir, scenario.id);
      await fs.mkdir(evidenceDir, { recursive: true });
      const content = "observed synthetic target\n";
      const digest = createHash("sha256").update(content).digest("hex");
      await fs.writeFile(path.join(evidenceDir, "target.log"), content);
      const source = buildScriptProducerEvidence({
        status: "pass",
        artifacts: [{ kind: "log", path: "target.log", source: "synthetic-target" }],
      });
      const occurrence: QaEvidenceOccurrence = {
        id: "observation",
        parentCell: null,
        scenario: null,
        retryOf: null,
        terminalStatus: "pass",
        assertions: null,
        launch: {
          source: { ref: null, integrity: null },
          runtime: { id: null, version: null },
          package: null,
          protocol: null,
          accountRef: null,
          proofClass: null,
        },
        receipts: [],
      };
      occurrence.receipts.push({
        id: "target",
        phase: "runtime",
        identity: structuredClone(occurrence.launch),
        artifact: { kind: "log", path: "target.log", source: "synthetic-target", sha256: digest },
      });
      const evidence = buildQaOccurrenceEvidenceSummary({
        generatedAt: source.generatedAt,
        evidenceMode,
        occurrences: [occurrence],
        entries: source.entries.map((entry) =>
          Object.assign({}, entry, {
            effective: true,
            binding: { occurrenceId: occurrence.id, assertionId: null, receiptId: "target" },
          }),
        ),
      });
      const evidencePath = path.join(evidenceDir, "qa-evidence.json");
      const raw = JSON.stringify(evidence);
      await fs.writeFile(evidencePath, raw);
      const { producerEvidence: imported } = await readScriptProducerEvidence({
        outputDir,
        repoRoot,
        scenario,
        requireCurrentRunEvidence: true,
      });
      expect(imported?.schemaVersion).toBe(3);
      if (imported?.schemaVersion !== 3) {
        throw new Error("expected occurrence evidence");
      }
      expect(imported.occurrences[0]!.receipts[0]!.artifact).toEqual({
        kind: "log",
        path: "<repo-root>/output/owned-scenario/target.log",
        source: "synthetic-target",
        sha256: digest,
      });
      expect(imported.entries[0]!.binding).toEqual(evidence.entries[0]!.binding);
      if (evidenceMode === "full") {
        expect(imported.entries[0]!.execution?.artifacts[0]?.path).toBe(
          "<repo-root>/output/owned-scenario/target.log",
        );
      } else {
        expect(imported.entries[0]!.execution).toBeUndefined();
      }
      expect(await fs.readFile(evidencePath, "utf8")).toBe(raw);
    },
  );

  it.each(["full", "slim"] as const)(
    "retains actual nested native %s files and receipt hashes across repeated imports",
    async (evidenceMode) => {
      const repoRoot = tempDirs.make("qa-native-receipt-base-");
      const outputDir = path.join(repoRoot, "outer");
      const scenario = { id: "native-child" };
      const evidenceDir = path.join(outputDir, scenario.id);
      const result = await runQaTestFileScenarios({
        ...QA_TEST_RUNNER_DEFAULTS,
        repoRoot,
        outputDir: evidenceDir,
        evidenceMode,
        scenarios: [makeTestFileScenario("vitest", "owned.test.ts")],
        runCommand: async (command) => {
          await writeNativeVitestReport(command, { passed: 1 });
          return { exitCode: 0, stdout: "actual captured fixture command output\n", stderr: "" };
        },
      });
      expect(result.results[0]!.status).toBe("pass");
      const original = await fs.readFile(result.evidencePath);
      const first = await readScriptProducerEvidence({
        repoRoot,
        outputDir,
        scenario,
        requireCurrentRunEvidence: true,
      });
      expect(first.producerEvidence).toEqual(result.evidence);
      if (first.producerEvidence?.schemaVersion !== 3) {
        throw new Error("expected native v3");
      }
      const receipt = first.producerEvidence.occurrences.flatMap((item) => item.receipts)[0]!;
      expect(receipt.artifact.path).toMatch(/^<repo-root>\/outer\/native-child\/occurrences\//u);
      const logPath = resolveQaArtifactPath(repoRoot, evidenceDir, receipt.artifact.path);
      expect(logPath).toBe(result.results[0]!.logPath);
      const logBytes = await fs.readFile(logPath);
      expect(createHash("sha256").update(logBytes).digest("hex")).toBe(receipt.artifact.sha256);
      expect(logBytes.toString()).toContain("actual captured fixture command output");
      const nextDir = path.join(repoRoot, "next", scenario.id);
      await fs.mkdir(nextDir, { recursive: true });
      const nextPath = path.join(nextDir, "qa-evidence.json");
      await fs.writeFile(nextPath, JSON.stringify(first.producerEvidence));
      const second = await readScriptProducerEvidence({
        repoRoot,
        outputDir: path.dirname(nextDir),
        scenario,
        requireCurrentRunEvidence: true,
      });
      expect(second.producerEvidence).toEqual(first.producerEvidence);
      expect(await fs.readFile(result.evidencePath)).toEqual(original);
      if (evidenceMode === "full") {
        expect(first.producerEvidence.entries[0]!.execution?.artifacts[0]?.path).toBe(
          receipt.artifact.path,
        );
      } else {
        expect(first.producerEvidence.entries[0]!.execution).toBeUndefined();
      }
    },
  );

  it.each(["null", "false", "0", '""'])(
    "rejects existing invalid %s instead of using another bundle",
    async (raw) => {
      const repoRoot = tempDirs.make("qa-script-malformed-");
      const outputDir = path.join(repoRoot, "output");
      const scenario = { id: "owned-scenario" };
      const evidenceDir = path.join(outputDir, scenario.id);
      await fs.mkdir(evidenceDir, { recursive: true });
      await fs.writeFile(
        path.join(evidenceDir, "latest-run.json"),
        JSON.stringify({ qaEvidence: "bad.json" }),
      );
      await fs.writeFile(path.join(evidenceDir, "bad.json"), raw);
      await fs.writeFile(
        path.join(evidenceDir, "qa-evidence.json"),
        JSON.stringify(buildScriptProducerEvidence({ status: "pass" })),
      );
      await expect(
        readScriptProducerEvidence({
          outputDir,
          repoRoot,
          scenario,
          requireCurrentRunEvidence: true,
        }),
      ).rejects.toThrow();
    },
  );
});
