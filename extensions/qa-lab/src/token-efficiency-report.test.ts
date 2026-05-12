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
  overrides: Partial<RuntimeParityCell> = {},
): RuntimeParityCell {
  return {
    runtime,
    transcriptBytes: '{"role":"assistant"}\n',
    toolCalls,
    finalText: "done",
    usage,
    wallClockMs: 10,
    bootStateLines: [],
    ...overrides,
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
  it("renders live side-by-side rows, flags Codex token/cost increases, and unions tools used", () => {
    const report = buildTokenEfficiencyReport({
      generatedAt: "2026-05-10T00:00:00.000Z",
      summary: makeLiveSummary([
        makeRuntimeParity(
          "delta-low",
          makeCell("pi", { inputTokens: 40, outputTokens: 60, totalTokens: 100, costUsd: 0.001 }, [
            makeToolCall("read_file"),
          ]),
          makeCell(
            "codex",
            { inputTokens: 55, outputTokens: 55, totalTokens: 110, costUsd: 0.0011 },
            [makeToolCall("read_file")],
          ),
        ),
        makeRuntimeParity(
          "flagged-delta",
          makeCell("pi", { inputTokens: 45, outputTokens: 55, totalTokens: 100, costUsd: 0.001 }),
          makeCell("codex", {
            inputTokens: 80,
            outputTokens: 50,
            totalTokens: 130,
            costUsd: 0.0013,
          }),
        ),
        makeRuntimeParity(
          "tool-difference",
          makeCell("pi", { inputTokens: 120, outputTokens: 80, totalTokens: 200, costUsd: 0.002 }, [
            makeToolCall("read_file"),
          ]),
          makeCell(
            "codex",
            { inputTokens: 100, outputTokens: 90, totalTokens: 190, costUsd: 0.001 },
            [makeToolCall("write_file"), makeToolCall("read_file")],
          ),
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
      costFlagged: true,
    });
    expect(report.rows[1]?.costDeltaPercent).toBeCloseTo(30);
    expect(report.rows[2]).toMatchObject({
      scenarioId: "tool-difference",
      pi: expect.objectContaining({ toolCallCount: 1 }),
      codex: expect.objectContaining({ toolCallCount: 2 }),
      flagged: false,
      costFlagged: false,
      toolsUsed: ["read_file", "write_file"],
    });
    expect(renderTokenEfficiencyMarkdownReport(report)).toMatchInlineSnapshot(`
      "# OpenClaw Runtime Token Efficiency - pi vs codex

      - Generated at: 2026-05-10T00:00:00.000Z
      - Provider mode: live-frontier
      - Verdict: fail
      - Usage source: live-usage
      - Threshold: Codex token/cost increase > 15.0%

      ## Aggregate Metrics

      | Runtime | Total tokens | p50 per turn | p90 per turn | Cost |
      | --- | ---: | ---: | ---: | ---: |
      | pi | 400 | 100 | 200 | $0.0040 |
      | codex | 430 | 130 | 190 | $0.0034 |
      | delta | +7.5% |  |  | -15.0% |

      ## Scenario Efficiency

      | Scenario | Source | Pi in/out/total/tools | Codex in/out/total/tools | Pi cost | Codex cost | Pi prompt/project/skills/tool-summary/tool-schema/transcript chars | Codex prompt/project/skills/tool-summary/tool-schema/transcript chars | Token delta | Cost delta | Flagged | Tools used |
      | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
      | delta-low | live-usage | 40/60/100/1 | 55/55/110/1 | $0.0010 | $0.0011 | 0/0/0/0/0/21 | 0/0/0/0/0/21 | +10.0% | +10.0% | no | read_file |
      | flagged-delta | live-usage | 45/55/100/0 | 80/50/130/0 | $0.0010 | $0.0013 | 0/0/0/0/0/21 | 0/0/0/0/0/21 | +30.0% | +30.0% | yes |  |
      | tool-difference | live-usage | 120/80/200/1 | 100/90/190/2 | $0.0020 | $0.0010 | 0/0/0/0/0/21 | 0/0/0/0/0/21 | -5.0% | -50.0% | no | read_file, write_file |

      ## Gate Failures

      - flagged-delta token delta=+30.0%, cost delta=+30.0% exceeds 15.0% Codex increase threshold

      ## Notes

      - Token totals are read from RuntimeParityCell.usage, which is captured from normalized AssistantMessage.usage.
      - Cost totals are read from AssistantMessage.usage.cost when present; rows without provider cost remain token-only.
      - The report does not inspect provider transport payload token counters.
      "
    `);
  });

  it("does not fail live reports solely because Codex uses fewer tokens or costs less", () => {
    const report = buildTokenEfficiencyReport({
      summary: makeLiveSummary([
        makeRuntimeParity(
          "codex-savings",
          makeCell("pi", { inputTokens: 120, outputTokens: 80, totalTokens: 200, costUsd: 0.004 }),
          makeCell("codex", {
            inputTokens: 60,
            outputTokens: 40,
            totalTokens: 100,
            costUsd: 0.001,
          }),
        ),
      ]),
    });

    expect(report.pass).toBe(true);
    expect(report.aggregate.flaggedScenarios).toEqual([]);
    expect(report.rows[0]).toMatchObject({
      deltaPercent: -50,
      costDeltaPercent: -75,
      flagged: false,
      costFlagged: false,
    });
  });

  it("fails live reports on cost-only Codex increases", () => {
    const report = buildTokenEfficiencyReport({
      summary: makeLiveSummary([
        makeRuntimeParity(
          "cost-only-regression",
          makeCell("pi", { inputTokens: 50, outputTokens: 50, totalTokens: 100, costUsd: 0.001 }),
          makeCell("codex", {
            inputTokens: 50,
            outputTokens: 50,
            totalTokens: 100,
            costUsd: 0.002,
          }),
        ),
      ]),
    });

    expect(report.pass).toBe(false);
    expect(report.aggregate.flaggedScenarios).toEqual(["cost-only-regression"]);
    expect(report.aggregate.costFlaggedScenarios).toEqual(["cost-only-regression"]);
    expect(report.failures).toEqual([
      "cost-only-regression cost delta=+100.0% exceeds 15.0% Codex increase threshold",
    ]);
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

  it("fails live reports when a scenario lacks runtime parity evidence", () => {
    const report = buildTokenEfficiencyReport({
      generatedAt: "2026-05-10T00:00:00.000Z",
      summary: {
        scenarios: [{ name: "missing-runtime-parity", status: "pass" }],
        run: {
          providerMode: "live-frontier",
          runtimePair: ["pi", "codex"],
        },
      },
    });

    expect(report.status).toBe("evaluated");
    expect(report.pass).toBe(false);
    expect(report.failures).toEqual(["missing-runtime-parity missing runtime parity result"]);
  });

  it("fails live reports when runtime cells failed or usage is zero", () => {
    const report = buildTokenEfficiencyReport({
      generatedAt: "2026-05-10T00:00:00.000Z",
      summary: {
        scenarios: [
          {
            name: "failed-live-row",
            status: "fail",
            runtimeParity: {
              ...makeRuntimeParity(
                "failed-live-row",
                makeCell("pi", { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, [], {
                  runtimeErrorClass: "scenario-failure",
                }),
                makeCell("codex", { inputTokens: 12, outputTokens: 8, totalTokens: 20 }, [], {
                  transportErrorClass: "codex-app-server",
                }),
              ),
              drift: "failure-mode",
            },
          },
        ],
        run: {
          providerMode: "live-frontier",
          runtimePair: ["pi", "codex"],
        },
      },
    });

    expect(report.status).toBe("evaluated");
    expect(report.pass).toBe(false);
    expect(report.failures).toEqual([
      "failed-live-row scenario status=fail",
      "failed-live-row drift=failure-mode",
      "failed-live-row pi runtimeErrorClass=scenario-failure",
      "failed-live-row pi live usage totalTokens=0",
      "failed-live-row codex transportErrorClass=codex-app-server",
    ]);
  });

  it("keeps mock zero-usage cells as labeled estimates instead of live failures", () => {
    const report = buildTokenEfficiencyReport({
      generatedAt: "2026-05-10T00:00:00.000Z",
      summary: {
        scenarios: [
          {
            name: "mock-zero",
            status: "fail",
            runtimeParity: {
              ...makeRuntimeParity(
                "mock-zero",
                makeCell("pi", { inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
                makeCell("codex", { inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
              ),
              drift: "failure-mode",
            },
          },
        ],
        run: {
          providerMode: "mock-openai",
          runtimePair: ["pi", "codex"],
        },
      },
    });

    expect(report.status).toBe("estimated");
    expect(report.pass).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.rows[0]?.usageSource).toBe("mock-estimate");
  });
});
