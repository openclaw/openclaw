import { describe, expect, it } from "vitest";
import type { QaParitySuiteSummary } from "./agentic-parity-report.js";
import { buildRuntimeParityCacheDiagnostics } from "./runtime-parity-cache-diagnostics.js";
import type {
  RuntimeParityCell,
  RuntimeParityResult,
  RuntimeParityToolCall,
} from "./runtime-parity.js";
import {
  buildTokenEfficiencyReport,
  renderTokenEfficiencyMarkdownReport,
} from "./token-efficiency-report.js";

function makeToolCall(tool: string): RuntimeParityToolCall {
  return { tool, argsHash: `${tool}-args`, resultHash: `${tool}-result` };
}

function usage(
  inputTokens: number,
  outputTokens = 0,
  totalTokens = inputTokens + outputTokens,
  cacheRead?: number,
  cacheWrite?: number,
): RuntimeParityCell["usage"] {
  return { inputTokens, outputTokens, totalTokens, cacheRead, cacheWrite };
}

type CellFixture = Omit<RuntimeParityCell, "runtime">;

function makeCell(
  cellUsage: RuntimeParityCell["usage"] = usage(100, 20),
  toolCalls: RuntimeParityToolCall[] = [],
  turns?: RuntimeParityCell["usage"][],
): CellFixture {
  return {
    transcriptBytes: '{"role":"assistant"}\n',
    toolCalls,
    finalText: "done",
    usage: cellUsage,
    wallClockMs: 10,
    bootStateLines: [],
    ...(turns ? { cacheDiagnostics: buildRuntimeParityCacheDiagnostics(turns) } : {}),
  };
}

function makeRuntimeParity(
  scenarioId: string,
  openclaw: CellFixture,
  codex: CellFixture,
  runtimeParityUsage?: RuntimeParityResult["runtimeParityUsage"],
): RuntimeParityResult {
  return {
    scenarioId,
    ...(runtimeParityUsage ? { runtimeParityUsage } : {}),
    drift: "none",
    cells: {
      openclaw: { ...openclaw, runtime: "openclaw", status: "pass" },
      codex: { ...codex, runtime: "codex", status: "pass" },
    },
  };
}

function makeSummary(
  runtimeParity: RuntimeParityResult[],
  providerMode = "live-frontier",
): QaParitySuiteSummary {
  return {
    scenarios: runtimeParity.map((result) => ({
      name: result.scenarioId,
      status: "pass" as const,
      runtimeParity: result,
    })),
    run: { providerMode, runtimePair: ["openclaw", "codex"] },
  };
}

function liveReport(...params: Parameters<typeof makeRuntimeParity>) {
  return buildTokenEfficiencyReport({ summary: makeSummary([makeRuntimeParity(...params)]) });
}

describe("token efficiency report", () => {
  it("detects a real cache regression even when cached-inclusive totals hide it", () => {
    const openclaw = makeCell(usage(7_403, 220, 435_810, 415_492, 12_695), [
      makeToolCall("fs.read"),
    ]);
    const codex = makeCell(
      usage(25_894, 220, 495_710, 445_189, 24_407),
      [makeToolCall("fs.read"), makeToolCall("fs.read")],
      [usage(3, 11, 24_421, 0, 24_407), usage(24_448, 11, 24_459, 0, 0)],
    );

    const report = liveReport("first-hour-cache-miss", openclaw, codex);

    expect(report.pass).toBe(false);
    expect(report.rows[0]).toMatchObject({
      classification: "regression",
      flagged: true,
      toolsUsed: ["fs.read"],
      openclaw: { processedTokens: 20_318, cacheReadTokens: 415_492 },
      codex: {
        processedTokens: 50_521,
        cacheReadTokens: 445_189,
        cacheWriteTokens: 24_407,
        cacheMisses: [{ turn: 2, inputTokens: 24_448, cacheRead: 0, cacheWrite: 0 }],
      },
    });
    expect(report.rows[0]?.deltaPercent).toBeGreaterThan(145);
    expect(report.failures).toEqual([
      "first-hour-cache-miss token delta=+148.7% exceeds 15.0% Codex increase threshold",
    ]);
    expect(report.aggregate.codex).toMatchObject({
      processedTokens: 50_521,
      cacheMissCount: 1,
      cacheMissInputTokens: 24_448,
    });
    expect(renderTokenEfficiencyMarkdownReport(report)).toContain("turn 2 (24448 input)");
  });

  it("derives missing cache writes only from coherent measured cache reads", () => {
    const report = liveReport(
      "derived-cache-writes",
      makeCell(usage(10, 5, 115, 100)),
      makeCell(usage(10, 5, 135, 100)),
    );

    expect(report.pass).toBe(false);
    expect(report.rows[0]).toMatchObject({
      classification: "regression",
      flagged: true,
      openclaw: { processedTokens: 15, processedTokenEvidence: "derived", cacheWriteTokens: null },
      codex: { processedTokens: 35, processedTokenEvidence: "derived", cacheWriteTokens: null },
    });
  });

  it("does not certify incomplete cache-write telemetry with unaccounted cache input", () => {
    const codex = makeCell(
      usage(100, 20, 1_120, 100, 200),
      [],
      [usage(3, 11, 314, 100, 200), usage(97, 9, 806)],
    );

    const report = liveReport("incomplete-cache-write-telemetry", makeCell(), codex);

    expect(report.pass).toBe(false);
    expect(report.rows[0]?.codex).toMatchObject({
      cacheReadTokens: 100,
      cacheWriteTokens: 200,
      processedTokenEvidence: "unavailable",
      unmeasuredPostWarmTurns: [2],
    });
    expect(report.failures).toEqual([
      "incomplete-cache-write-telemetry codex live processed-token usage cannot be verified from cache-write telemetry or coherent cache-read totals",
    ]);
  });

  it.each([
    {
      name: "mixed-cache-telemetry",
      cell: makeCell(
        usage(1_053, 33, 2_086, 0, 1_000),
        [],
        [usage(3, 11, 1_014, 0, 1_000), usage(1_050, 11, 1_061, 0, 0), usage(0, 11)],
      ),
      misses: [{ turn: 2, inputTokens: 1_050, cacheRead: 0, cacheWrite: 0 }],
      unmeasured: [3],
      markdown: "turn 2 (1050 input); unmeasured turns 3",
    },
    {
      name: "partial-warm-telemetry",
      cell: makeCell(undefined, [], [usage(3, 11, 1_014, undefined, 1_000), usage(100, 11)]),
      misses: null,
      unmeasured: [2],
      markdown: "N/A (unmeasured turns 2)",
    },
  ])(
    "preserves unknown $name without discarding measured misses",
    ({ name, cell, misses, unmeasured, markdown }) => {
      const report = liveReport(name, makeCell(), cell);
      if (name === "partial-warm-telemetry") {
        expect(report.pass).toBe(true);
      }
      expect(report).toMatchObject({
        rows: [{ codex: { cacheMisses: misses, unmeasuredPostWarmTurns: unmeasured } }],
        aggregate: { codex: { cacheMissCount: null, cacheMissInputTokens: null } },
      });
      expect(renderTokenEfficiencyMarkdownReport(report)).toContain(markdown);
    },
  );

  it.each([
    [
      "zero",
      usage(0),
      usage(0),
      ["openclaw live usage totalTokens=0", "codex live usage totalTokens=0"],
    ],
    [
      "fractional",
      usage(100.5),
      usage(101),
      [
        "openclaw live usage inputTokens must be a non-negative integer",
        "openclaw live usage totalTokens must be a non-negative integer",
      ],
    ],
  ] as const)("rejects %s live token usage", (name, openclaw, codex, failures) => {
    const report = liveReport(name, makeCell(openclaw), makeCell(codex));
    expect(report.pass).toBe(false);
    expect(report.failures).toEqual(failures.map((failure) => `${name} ${failure}`));
  });

  it("keeps completed measurements but fails a live report with an incomplete pair", () => {
    const cell = makeCell(usage(100, 20, 120, 0, 0));
    const summary = makeSummary([makeRuntimeParity("completed", cell, cell)]);
    expect(buildTokenEfficiencyReport({ summary }).pass).toBe(true);

    summary.scenarios.push({ name: "incomplete", status: "fail" });
    const report = buildTokenEfficiencyReport({ summary });
    expect(report.rows.map((row) => row.scenarioId)).toEqual(["completed"]);
    expect(report.pass).toBe(false);
    expect(report.failures).toEqual(["incomplete: runtime parity capture missing"]);
  });

  it("fails live reports with only usage-not-applicable captures", () => {
    const report = liveReport("local-fixture", makeCell(usage(0)), makeCell(usage(0)), {
      expectation: "not-applicable",
      reason: "Local fixture only; no assistant turn runs.",
    });

    expect(report).toMatchObject({ status: "evaluated", pass: false, rows: [] });
    expect(report.failures).toEqual([
      "No usage-applicable runtime parity captures were present in the suite summary.",
    ]);
    expect(renderTokenEfficiencyMarkdownReport(report)).toContain("- Verdict: fail");
  });

  it("keeps empty mock runtime summaries skipped as non-live estimates", () => {
    const report = buildTokenEfficiencyReport({
      summary: makeSummary([], "mock-openai"),
    });

    expect(report).toMatchObject({ status: "skipped", pass: true, failures: [] });
  });

  it("labels mock-estimated Codex increases as regressions without failing the live gate", () => {
    const report = buildTokenEfficiencyReport({
      summary: makeSummary(
        [makeRuntimeParity("mock-regression", makeCell(usage(100)), makeCell(usage(130)))],
        "mock-openai",
      ),
    });

    expect(report).toMatchObject({
      status: "estimated",
      pass: true,
      aggregate: { flaggedScenarios: [] },
      rows: [{ usageSource: "mock-estimate", classification: "regression", flagged: false }],
    });
  });

  it("renders savings and regression classifications in the markdown report", () => {
    const report = buildTokenEfficiencyReport({
      generatedAt: "2026-05-10T00:00:00.000Z",
      summary: makeSummary([
        makeRuntimeParity("codex-savings", makeCell(usage(100, 100)), makeCell(usage(50, 50))),
        makeRuntimeParity("codex-regression", makeCell(usage(100)), makeCell(usage(130))),
      ]),
    });

    const markdown = renderTokenEfficiencyMarkdownReport(report);
    expect(markdown).toContain("p50 per scenario");
    expect(markdown).toContain("| codex-savings | live-usage |");
    expect(markdown).toContain("| -50.0% | savings | no |");
    expect(markdown).toContain("| codex-regression | live-usage |");
    expect(markdown).toContain("| +30.0% | regression | yes |");
  });
});
