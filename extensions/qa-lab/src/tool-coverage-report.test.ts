import { describe, expect, it } from "vitest";
import { readQaScenarioPack, type QaSeedScenarioWithSource } from "./scenario-catalog.js";
import {
  buildQaToolCoverageReport,
  renderQaToolCoverageMarkdownReport,
} from "./tool-coverage-report.js";

function makeScenario(
  id: string,
  tool: string,
  config: Record<string, unknown> = {},
): QaSeedScenarioWithSource {
  return {
    id,
    title: id,
    surface: "runtime-tools",
    coverage: {
      primary: [`tools.${tool}`],
    },
    objective: "exercise tool",
    successCriteria: ["tool is exercised"],
    sourcePath: `qa/scenarios/runtime/tools/${tool}.md`,
    execution: {
      kind: "flow",
      config,
      flow: {
        steps: [
          {
            name: "noop",
            actions: [{ assert: "true" }],
          },
        ],
      },
    },
  };
}

describe("qa tool coverage report", () => {
  it("renders catalog-only tool fixture coverage", () => {
    const report = buildQaToolCoverageReport({
      scenarios: [makeScenario("tool-read", "read")],
      generatedAt: "2026-05-10T00:00:00.000Z",
    });

    expect(report.evaluated).toBe(false);
    expect(report.rows).toEqual([
      expect.objectContaining({
        tool: "read",
        bucket: "required-default",
        fixtureCount: 1,
        pi: "not-run",
        codex: "not-run",
        drift: "not-run",
      }),
    ]);
    expect(renderQaToolCoverageMarkdownReport(report)).toContain(
      "| read | required-default | 1 | not-run | not-run | not-run |",
    );
  });

  it("uses runtime parity summary rows and allows tracked known-broken drift", () => {
    const report = buildQaToolCoverageReport({
      scenarios: [
        makeScenario("tool-read", "read"),
        makeScenario("tool-write", "write", {
          knownBroken: {
            issue: "#80236",
            reason: "tracked runtime drift",
          },
        }),
      ],
      summary: {
        scenarios: [
          {
            name: "tool read",
            status: "pass",
            runtimeParity: {
              scenarioId: "tool-read",
              drift: "none",
              cells: {
                pi: {
                  runtime: "pi",
                  transcriptBytes: "",
                  toolCalls: [{ tool: "read", argsHash: "a", resultHash: "r" }],
                  finalText: "",
                  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                  wallClockMs: 1,
                  bootStateLines: [],
                },
                codex: {
                  runtime: "codex",
                  transcriptBytes: "",
                  toolCalls: [{ tool: "read", argsHash: "a", resultHash: "r" }],
                  finalText: "",
                  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                  wallClockMs: 1,
                  bootStateLines: [],
                },
              },
            },
          },
          {
            name: "tool write",
            status: "fail",
            runtimeParity: {
              scenarioId: "tool-write",
              drift: "tool-result-shape",
              driftDetails: "tool result differs",
              cells: {
                pi: {
                  runtime: "pi",
                  transcriptBytes: "",
                  toolCalls: [{ tool: "write", argsHash: "a", resultHash: "r1" }],
                  finalText: "",
                  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                  wallClockMs: 1,
                  bootStateLines: [],
                },
                codex: {
                  runtime: "codex",
                  transcriptBytes: "",
                  toolCalls: [{ tool: "write", argsHash: "a", resultHash: "r2" }],
                  finalText: "",
                  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                  wallClockMs: 1,
                  bootStateLines: [],
                },
              },
            },
          },
        ],
        run: {
          runtimePair: ["pi", "codex"],
        },
      },
      generatedAt: "2026-05-10T00:00:00.000Z",
    });

    expect(report.pass).toBe(true);
    expect(report.rows.find((row) => row.tool === "write")).toEqual(
      expect.objectContaining({
        drift: "tool-result-shape",
        tracking: "#80236 tracked runtime drift",
      }),
    );
  });

  it("keeps optional plugin-dependent tool drift report-only", () => {
    const report = buildQaToolCoverageReport({
      scenarios: [
        makeScenario("tool-optional", "optional", {
          expectedAvailable: false,
        }),
      ],
      summary: {
        scenarios: [
          {
            name: "tool optional",
            status: "fail",
            runtimeParity: {
              scenarioId: "tool-optional",
              drift: "tool-call-shape",
              cells: {
                pi: {
                  runtime: "pi",
                  transcriptBytes: "",
                  toolCalls: [],
                  finalText: "",
                  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                  wallClockMs: 1,
                  bootStateLines: [],
                },
                codex: {
                  runtime: "codex",
                  transcriptBytes: "",
                  toolCalls: [{ tool: "optional", argsHash: "a", resultHash: "r" }],
                  finalText: "",
                  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                  wallClockMs: 1,
                  bootStateLines: [],
                },
              },
            },
          },
        ],
      },
      generatedAt: "2026-05-10T00:00:00.000Z",
    });

    expect(report.pass).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.rows[0]).toEqual(
      expect.objectContaining({
        bucket: "optional-plugin",
        drift: "tool-call-shape",
      }),
    );
  });

  it("discovers the runtime tool fixture catalog", () => {
    const report = buildQaToolCoverageReport({
      scenarios: readQaScenarioPack().scenarios,
      generatedAt: "2026-05-10T00:00:00.000Z",
    });
    const tools = report.rows.map((row) => row.tool);

    expect(tools).toEqual(
      expect.arrayContaining([
        "apply-patch",
        "bash",
        "exec",
        "fs.read",
        "image-generate",
        "memory.recall",
        "message-tool",
        "sessions-spawn",
        "tavily-search",
        "web-fetch",
      ]),
    );
    const applyPatchRow = report.rows.find((row) => row.tool === "apply-patch");
    expect(applyPatchRow).toEqual(expect.objectContaining({ bucket: "required-default" }));
    expect(applyPatchRow).toEqual(
      expect.objectContaining({
        tracking:
          "#80320 QA mock apply_patch fixture still uses synthetic failure-path inputs; provider remap fixed tool exposure, but failure injection remains harness-only.",
      }),
    );
    expect(report.rows.find((row) => row.tool === "message-tool")).toEqual(
      expect.objectContaining({
        bucket: "optional-plugin",
        tracking:
          "Direct message is not part of the coding-profile default surface; session messaging uses sessions_send.",
      }),
    );
    expect(report.rows.find((row) => row.tool === "tavily-search")).toEqual(
      expect.objectContaining({
        tracking:
          "#80173 Tavily tools are listed in the phase matrix but are not exposed by the current default tool surface.",
      }),
    );
  });
});
