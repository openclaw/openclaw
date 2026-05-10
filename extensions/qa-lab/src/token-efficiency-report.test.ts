import { describe, expect, it } from "vitest";
import type {
  RuntimeId,
  RuntimeParityCell,
  RuntimeParityResult,
  RuntimeParityToolCall,
} from "./runtime-parity.js";
import {
  buildTokenEfficiencyReport,
  renderTokenEfficiencyMarkdownReport,
  type TokenEfficiencySuiteSummary,
} from "./token-efficiency-report.js";

function makeToolCall(tool: string): RuntimeParityToolCall {
  return {
    tool,
    argsHash: `${tool}-args`,
    resultHash: `${tool}-result`,
  };
}

function makeCell(
  runtime: RuntimeId,
  usage: RuntimeParityCell["usage"],
  toolCalls: RuntimeParityToolCall[] = [],
): RuntimeParityCell {
  return {
    runtime,
    transcriptBytes: '{"role":"assistant"}\n',
    toolCalls,
    finalText: "done",
    usage,
    wallClockMs: 10,
    bootStateLines: [],
  };
}

function makeRuntimeParity(
  scenarioId: string,
  pi: RuntimeParityCell,
  codex: RuntimeParityCell,
): RuntimeParityResult {
  return {
    scenarioId,
    drift: "none",
    cells: { pi, codex },
  };
}

function makeLiveSummary(runtimeParity: RuntimeParityResult[]): TokenEfficiencySuiteSummary {
  return {
    scenarios: runtimeParity.map((result) => ({
      name: result.scenarioId,
      status: "pass" as const,
      runtimeParity: result,
    })),
    run: {
      providerMode: "live-frontier",
      runtimePair: ["pi", "codex"],
    },
  };
}

describe("token efficiency report", () => {
  it("renders live side-by-side rows, flags large deltas, and unions tools used", () => {
    const report = buildTokenEfficiencyReport({
      generatedAt: "2026-05-10T00:00:00.000Z",
      summary: makeLiveSummary([
        makeRuntimeParity(
          "delta-low",
          makeCell("pi", { inputTokens: 40, outputTokens: 60, totalTokens: 100 }, [
            makeToolCall("read_file"),
          ]),
          makeCell("codex", { inputTokens: 55, outputTokens: 55, totalTokens: 110 }, [
            makeToolCall("read_file"),
          ]),
        ),
        makeRuntimeParity(
          "flagged-delta",
          makeCell("pi", { inputTokens: 45, outputTokens: 55, totalTokens: 100 }),
          makeCell("codex", { inputTokens: 80, outputTokens: 50, totalTokens: 130 }),
        ),
        makeRuntimeParity(
          "tool-difference",
          makeCell("pi", { inputTokens: 120, outputTokens: 80, totalTokens: 200 }, [
            makeToolCall("read_file"),
          ]),
          makeCell("codex", { inputTokens: 100, outputTokens: 90, totalTokens: 190 }, [
            makeToolCall("write_file"),
            makeToolCall("read_file"),
          ]),
        ),
      ]),
    });

    expect(report.status).toBe("evaluated");
    expect(report.pass).toBe(false);
    expect(report.aggregate.flaggedScenarios).toEqual(["flagged-delta"]);
    expect(report.rows[1]).toMatchObject({
      scenarioId: "flagged-delta",
      deltaPercent: 30,
      flagged: true,
    });
    expect(report.rows[2]).toMatchObject({
      scenarioId: "tool-difference",
      pi: expect.objectContaining({ toolCallCount: 1 }),
      codex: expect.objectContaining({ toolCallCount: 2 }),
      toolsUsed: ["read_file", "write_file"],
    });
    expect(renderTokenEfficiencyMarkdownReport(report)).toMatchInlineSnapshot(`
      "# OpenClaw Runtime Token Efficiency - pi vs codex

      - Generated at: 2026-05-10T00:00:00.000Z
      - Provider mode: live-frontier
      - Verdict: fail
      - Usage source: live-usage
      - Threshold: absolute delta > 15.0%

      ## Aggregate Metrics

      | Runtime | Total tokens | p50 per turn | p90 per turn |
      | --- | ---: | ---: | ---: |
      | pi | 400 | 100 | 200 |
      | codex | 430 | 130 | 190 |
      | delta | +7.5% |  |  |

      ## Scenario Efficiency

      | Scenario | Source | Pi in/out/total/tools | Codex in/out/total/tools | Pi prompt/project/skills/tool-summary/tool-schema/transcript chars | Codex prompt/project/skills/tool-summary/tool-schema/transcript chars | Delta | Flagged | Tools used |
      | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
      | delta-low | live-usage | 40/60/100/1 | 55/55/110/1 | 0/0/0/0/0/21 | 0/0/0/0/0/21 | +10.0% | no | read_file |
      | flagged-delta | live-usage | 45/55/100/0 | 80/50/130/0 | 0/0/0/0/0/21 | 0/0/0/0/0/21 | +30.0% | yes |  |
      | tool-difference | live-usage | 120/80/200/1 | 100/90/190/2 | 0/0/0/0/0/21 | 0/0/0/0/0/21 | -5.0% | no | read_file, write_file |

      ## Gate Failures

      - flagged-delta delta=+30.0% exceeds 15.0% threshold

      ## Notes

      - Token totals are read from RuntimeParityCell.usage, which is captured from normalized AssistantMessage.usage.
      - The report does not inspect provider transport payload token counters.
      "
    `);
  });

  it("computes aggregate totals and nearest-rank per-turn percentiles from cell usage", () => {
    const report = buildTokenEfficiencyReport({
      summary: makeLiveSummary(
        [10, 20, 30, 40, 50].map((piTotal, index) =>
          makeRuntimeParity(
            `scenario-${index}`,
            makeCell("pi", {
              inputTokens: piTotal - 1,
              outputTokens: 1,
              totalTokens: piTotal,
            }),
            makeCell("codex", {
              inputTokens: piTotal + 1,
              outputTokens: 1,
              totalTokens: piTotal + 2,
            }),
          ),
        ),
      ),
    });

    expect(report.aggregate.pi).toEqual({
      totalTokens: 150,
      p50PerTurn: 30,
      p90PerTurn: 50,
    });
    expect(report.aggregate.codex).toEqual({
      totalTokens: 160,
      p50PerTurn: 32,
      p90PerTurn: 52,
    });
    expect(report.aggregate.deltaPercent).toBeCloseTo(6.667, 3);
  });

  it("emits clearly labeled mock estimates instead of live-token truth", () => {
    const report = buildTokenEfficiencyReport({
      generatedAt: "2026-05-10T00:00:00.000Z",
      summary: {
        scenarios: [
          {
            name: "mock-fixed",
            status: "pass",
            runtimeParity: makeRuntimeParity(
              "mock-fixed",
              makeCell("pi", { inputTokens: 64, outputTokens: 16, totalTokens: 80 }),
              makeCell("codex", { inputTokens: 64, outputTokens: 16, totalTokens: 80 }),
            ),
          },
        ],
        run: {
          providerMode: "mock-openai",
          runtimePair: ["pi", "codex"],
        },
      },
    });

    expect(report.status).toBe("estimated");
    expect(report.rows).toEqual([
      expect.objectContaining({
        scenarioId: "mock-fixed",
        usageSource: "mock-estimate",
        pi: expect.objectContaining({ totalTokens: 7 }),
        codex: expect.objectContaining({ totalTokens: 7 }),
      }),
    ]);
    expect(report.aggregate.flaggedScenarios).toEqual([]);
    expect(renderTokenEfficiencyMarkdownReport(report)).toContain("- Usage source: mock-estimate");
    expect(renderTokenEfficiencyMarkdownReport(report)).toContain(
      "Mock token totals are algorithmic estimates",
    );
  });
});
