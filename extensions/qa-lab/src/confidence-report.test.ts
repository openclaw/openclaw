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
      counts: { total: 20, passed: 18, skipped: 2, failed: 0 },
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
    expect(report.globalPass).toBe(false);
    expect(report.counts).toMatchObject({ passed: 2, blocked: 1, unknown: 0, failed: 0 });
    expect(report.lanes.map((lane) => lane.verdict)).toEqual([
      "pass",
      "pass",
      "environment-blocked",
    ]);
    expect(report.lanes[0]?.details).toContain("counts.skipped=2");
    expect(renderQaConfidenceMarkdownReport(report)).toContain("Zero unknowns: yes");
    expect(renderQaConfidenceMarkdownReport(report)).toContain("Global pass: no");
  });

  it("fails strict global pass when any lane is blocked, missing, unknown, or classified failed", async () => {
    await writeJson("classified/qa-suite-summary.json", {
      counts: { total: 1, passed: 0, skipped: 0, failed: 1 },
      scenarios: [{ name: "classified", status: "fail" }],
    });
    await writeJson("unknown/qa-suite-summary.json", {
      counts: { total: 1, passed: 0, skipped: 0, failed: 1 },
      scenarios: [{ name: "unknown", status: "fail" }],
    });

    const report = await buildQaConfidenceReport({
      manifest: {
        version: 1,
        profile: "codex-100",
        lanes: [
          {
            id: "blocked-live",
            title: "Blocked live",
            kind: "qa-suite-summary",
            artifact: "live/qa-suite-summary.json",
            required: true,
            missingVerdict: "environment-blocked",
            missingReason: "OPENAI_API_KEY missing.",
          },
          {
            id: "missing-soak",
            title: "Missing soak",
            kind: "qa-suite-summary",
            artifact: "soak/qa-suite-summary.json",
            required: true,
          },
          {
            id: "classified-fixture",
            title: "Classified fixture",
            kind: "qa-suite-summary",
            artifact: "classified/qa-suite-summary.json",
            required: true,
            failureVerdict: "fixture-bug",
          },
          {
            id: "unknown-failure",
            title: "Unknown failure",
            kind: "qa-suite-summary",
            artifact: "unknown/qa-suite-summary.json",
            required: true,
          },
        ],
      },
      artifactRoot: tempRoot,
      strictZeroUnknowns: true,
      strictGlobalPass: true,
      generatedAt: "2026-05-12T00:00:00.000Z",
    });

    expect(report.pass).toBe(false);
    expect(report.zeroUnknowns).toBe(false);
    expect(report.globalPass).toBe(false);
    expect(report.counts).toMatchObject({
      blocked: 1,
      missing: 1,
      failed: 1,
      unknown: 2,
    });
    expect(report.failures).toEqual([
      "blocked-live is blocked: OPENAI_API_KEY missing.",
      "missing-soak is missing: artifact missing and no missingVerdict was configured",
      "classified-fixture is classified fixture-bug: qa-suite-summary counts.failed=1 counts.skipped=0",
      "unknown-failure is unclassified: qa-suite-summary counts.failed=1 counts.skipped=0",
    ]);
  });

  it("fails strict global pass for skipped suite rows until a backfill lane passes", async () => {
    await writeJson("report-only/qa-suite-summary.json", {
      counts: { total: 3, passed: 2, skipped: 1, failed: 0 },
      scenarios: [],
    });

    const report = await buildQaConfidenceReport({
      manifest: {
        version: 1,
        profile: "codex-100",
        lanes: [
          {
            id: "report-only",
            title: "Report-only",
            kind: "qa-suite-summary",
            artifact: "report-only/qa-suite-summary.json",
            required: true,
          },
        ],
      },
      artifactRoot: tempRoot,
      strictZeroUnknowns: true,
      strictGlobalPass: true,
      generatedAt: "2026-05-12T00:00:00.000Z",
    });

    expect(report.zeroUnknowns).toBe(true);
    expect(report.globalPass).toBe(false);
    expect(report.failures).toEqual([
      "report-only has 1 skipped row(s) with no passing backfill lane",
    ]);
  });

  it("rejects skipped token reports when a live usage source is required", async () => {
    await writeJson("live-token/qa-runtime-token-efficiency-summary.json", {
      status: "skipped",
      pass: true,
      rows: [],
    });

    const report = await buildQaConfidenceReport({
      manifest: {
        version: 1,
        profile: "codex-100",
        lanes: [
          {
            id: "live-token-efficiency",
            title: "Live token efficiency",
            kind: "token-efficiency-summary",
            artifact: "live-token/qa-runtime-token-efficiency-summary.json",
            required: true,
            expectedTokenUsageSource: "live-usage",
          },
        ],
      },
      artifactRoot: tempRoot,
      strictZeroUnknowns: true,
      generatedAt: "2026-05-12T00:00:00.000Z",
    });

    expect(report.pass).toBe(false);
    expect(report.lanes[0]).toMatchObject({
      status: "unknown",
      details: "token summary has no live-usage rows",
    });
  });

  it("preserves partial zero-unknown mode for classified failing lanes", async () => {
    await writeJson("classified/qa-suite-summary.json", {
      counts: { total: 1, passed: 0, skipped: 0, failed: 1 },
      scenarios: [{ name: "classified", status: "fail" }],
    });

    const report = await buildQaConfidenceReport({
      manifest: {
        version: 1,
        profile: "codex-100",
        lanes: [
          {
            id: "classified-fixture",
            title: "Classified fixture",
            kind: "qa-suite-summary",
            artifact: "classified/qa-suite-summary.json",
            required: true,
            failureVerdict: "fixture-bug",
          },
        ],
      },
      artifactRoot: tempRoot,
      strictZeroUnknowns: true,
      generatedAt: "2026-05-12T00:00:00.000Z",
    });

    expect(report.pass).toBe(true);
    expect(report.zeroUnknowns).toBe(true);
    expect(report.globalPass).toBe(false);
    expect(report.counts.failed).toBe(1);
  });

  it("passes strict global pass when skipped suite rows are backfilled by a passing lane", async () => {
    await writeJson("report-only/qa-suite-summary.json", {
      counts: { total: 3, passed: 2, skipped: 1, failed: 0 },
      scenarios: [],
    });
    await writeJson("live-backfill/qa-suite-summary.json", {
      counts: { total: 1, passed: 1, skipped: 0, failed: 0 },
      scenarios: [],
    });

    const report = await buildQaConfidenceReport({
      manifest: {
        version: 1,
        profile: "codex-100",
        lanes: [
          {
            id: "report-only",
            title: "Report-only",
            kind: "qa-suite-summary",
            artifact: "report-only/qa-suite-summary.json",
            required: true,
            skipBackfillLane: "live-backfill",
          },
          {
            id: "live-backfill",
            title: "Live backfill",
            kind: "qa-suite-summary",
            artifact: "live-backfill/qa-suite-summary.json",
            required: true,
          },
        ],
      },
      artifactRoot: tempRoot,
      strictZeroUnknowns: true,
      strictGlobalPass: true,
      generatedAt: "2026-05-12T00:00:00.000Z",
    });

    expect(report.pass).toBe(true);
    expect(report.zeroUnknowns).toBe(true);
    expect(report.globalPass).toBe(true);
    expect(report.lanes[0]).toMatchObject({
      skippedCount: 1,
      skipBackfillLane: "live-backfill",
      skipBackfilled: true,
    });
  });

  it("classifies environment-blocking gateway sentinels without turning them into unknowns", async () => {
    await writeJson("live/qa-suite-summary.json", {
      counts: { total: 1, passed: 1, skipped: 0, failed: 0 },
      gatewayLogSentinels: [
        {
          kind: "live-quota-or-subscription",
          verdict: "environment-blocked",
          owner: "environment",
          productImpact: "P4",
          qaImpact: "P0",
          line: 12,
          text: "OpenAI quota exceeded",
        },
      ],
      scenarios: [],
    });

    const report = await buildQaConfidenceReport({
      manifest: {
        version: 1,
        profile: "codex-100",
        lanes: [
          {
            id: "first-hour-live",
            title: "First hour live",
            kind: "qa-suite-summary",
            artifact: "live/qa-suite-summary.json",
            required: true,
          },
        ],
      },
      artifactRoot: tempRoot,
      strictZeroUnknowns: true,
      generatedAt: "2026-05-13T00:00:00.000Z",
    });

    expect(report.pass).toBe(true);
    expect(report.globalPass).toBe(false);
    expect(report.counts).toMatchObject({ blocked: 1, unknown: 0 });
    expect(report.lanes[0]).toMatchObject({
      status: "blocked",
      verdict: "environment-blocked",
    });
  });

  it("classifies product and plugin gateway sentinels as known failing lanes", async () => {
    await writeJson("live/qa-suite-summary.json", {
      counts: { total: 1, passed: 1, skipped: 0, failed: 0 },
      scenarios: [
        {
          name: "plugin hook health sentinel",
          status: "pass",
          steps: [],
          runtimeParity: {
            scenarioId: "plugin-hook-health-sentinel",
            drift: "none",
            cells: {
              pi: { gatewayLogSentinels: [] },
              codex: {
                gatewayLogSentinels: [
                  {
                    kind: "plugin-hook-failure",
                    verdict: "qa-harness-bug",
                    owner: "plugin",
                    productImpact: "P1",
                    qaImpact: "P0",
                    line: 4,
                    text: "before_prompt_build hook failed",
                  },
                ],
              },
            },
          },
        },
      ],
    });

    const report = await buildQaConfidenceReport({
      manifest: {
        version: 1,
        profile: "codex-100",
        lanes: [
          {
            id: "first-hour-live",
            title: "First hour live",
            kind: "qa-suite-summary",
            artifact: "live/qa-suite-summary.json",
            required: true,
          },
        ],
      },
      artifactRoot: tempRoot,
      strictZeroUnknowns: true,
      generatedAt: "2026-05-13T00:00:00.000Z",
    });

    expect(report.pass).toBe(true);
    expect(report.globalPass).toBe(false);
    expect(report.counts).toMatchObject({ failed: 1, unknown: 0 });
    expect(report.lanes[0]).toMatchObject({
      status: "fail",
      verdict: "qa-harness-bug",
    });
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
    expect(report.globalPass).toBe(false);
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
