import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildQaConfidenceReport,
  buildQaConfidenceSelfTestSummary,
  renderQaConfidenceMarkdownReport,
  writeQaConfidenceSelfTestArtifacts,
  type QaConfidenceManifest,
} from "./confidence-report.js";

describe("qa confidence report", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qa-confidence-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  async function writeJson(relativePath: string, payload: unknown) {
    const filePath = path.join(tempRoot, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return filePath;
  }

  it("passes strict zero-unknowns when every lane passes or has an allowed blocked verdict", async () => {
    await writeJson("tool-defaults/qa-suite-summary.json", {
      counts: { total: 20, passed: 20, failed: 0 },
      scenarios: [],
    });
    await writeJson("token/qa-runtime-token-efficiency-summary.json", {
      status: "estimated",
      pass: true,
      rows: [{ scenarioId: "one", usageSource: "mock-estimate" }],
    });

    const manifest: QaConfidenceManifest = {
      version: 1,
      profile: "codex-100",
      lanes: [
        {
          id: "tool-defaults-direct",
          title: "Tool defaults direct",
          kind: "qa-suite-summary",
          artifact: "tool-defaults/qa-suite-summary.json",
          required: true,
        },
        {
          id: "mock-token-efficiency",
          title: "Mock token efficiency",
          kind: "token-efficiency-summary",
          artifact: "token/qa-runtime-token-efficiency-summary.json",
          required: true,
          expectedTokenUsageSource: "mock-estimate",
        },
        {
          id: "live-token-efficiency",
          title: "Live token efficiency",
          kind: "token-efficiency-summary",
          artifact: "live/qa-runtime-token-efficiency-summary.json",
          required: true,
          missingVerdict: "environment-blocked",
          missingReason: "OPENAI OAuth credentials are not available in this runner.",
        },
      ],
    };

    const report = await buildQaConfidenceReport({
      manifest,
      artifactRoot: tempRoot,
      strictZeroUnknowns: true,
      generatedAt: "2026-05-12T00:00:00.000Z",
    });

    expect(report.pass).toBe(true);
    expect(report.counts).toMatchObject({ passed: 2, blocked: 1, unknown: 0, failed: 0 });
    expect(report.lanes.map((lane) => lane.verdict)).toEqual([
      "pass",
      "pass",
      "environment-blocked",
    ]);
    expect(renderQaConfidenceMarkdownReport(report)).toContain("Zero unknowns: yes");
  });

  it("fails strict zero-unknowns for an unclassified failing lane", async () => {
    await writeJson("first-hour/qa-suite-summary.json", {
      counts: { total: 18, passed: 17, failed: 1 },
      scenarios: [{ name: "approval-turn-tool-followthrough", status: "fail", steps: [] }],
    });

    const report = await buildQaConfidenceReport({
      manifest: {
        version: 1,
        profile: "codex-100",
        lanes: [
          {
            id: "first-hour-20-direct",
            title: "First-hour 20 direct",
            kind: "qa-suite-summary",
            artifact: "first-hour/qa-suite-summary.json",
            required: true,
          },
        ],
      },
      artifactRoot: tempRoot,
      strictZeroUnknowns: true,
      generatedAt: "2026-05-12T00:00:00.000Z",
    });

    expect(report.pass).toBe(false);
    expect(report.counts.unknown).toBe(1);
    expect(report.failures[0]).toContain("first-hour-20-direct is unclassified");
  });

  it("accepts a classified failing lane without treating it as unknown", async () => {
    await writeJson("jsonl/qa-jsonl-replay-summary.json", {
      transcripts: [
        {
          transcriptPath: "curated.jsonl",
          userTurnCount: 2,
          drift: ["none", "tool-result-shape"],
          firstDriftAtTurn: 2,
        },
      ],
    });

    const report = await buildQaConfidenceReport({
      manifest: {
        version: 1,
        profile: "codex-100",
        lanes: [
          {
            id: "jsonl-expanded",
            title: "Expanded JSONL replay",
            kind: "jsonl-replay-summary",
            artifact: "jsonl/qa-jsonl-replay-summary.json",
            required: true,
            failureVerdict: "fixture-bug",
            productImpact: "P4",
            qaImpact: "P1",
          },
        ],
      },
      artifactRoot: tempRoot,
      strictZeroUnknowns: true,
      generatedAt: "2026-05-12T00:00:00.000Z",
    });

    expect(report.pass).toBe(true);
    expect(report.counts.failed).toBe(1);
    expect(report.counts.unknown).toBe(0);
    expect(report.lanes[0]).toMatchObject({
      status: "fail",
      verdict: "fixture-bug",
      productImpact: "P4",
      qaImpact: "P1",
    });
  });

  it("emits confidence self-test canaries for every drift class we need to catch", async () => {
    const summary = await buildQaConfidenceSelfTestSummary("2026-05-12T00:00:00.000Z");

    expect(summary.pass).toBe(true);
    expect(summary.canaries.map((canary) => canary.id)).toEqual([
      "prompt-drift",
      "tool-description-schema-drift",
      "runtime-tool-call-drop",
      "tool-result-mismatch",
      "failure-mode-drift",
      "token-efficiency-regression",
      "jsonl-replay-ordering-drift",
    ]);
    expect(summary.canaries.every((canary) => canary.detected)).toBe(true);
  });

  it("writes confidence self-test artifacts", async () => {
    const result = await writeQaConfidenceSelfTestArtifacts({
      outputDir: tempRoot,
      generatedAt: "2026-05-12T00:00:00.000Z",
    });

    await expect(fs.stat(result.summaryPath)).resolves.toBeTruthy();
    await expect(fs.stat(result.reportPath)).resolves.toBeTruthy();
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as { pass: boolean };
    expect(summary.pass).toBe(true);
  });
});
