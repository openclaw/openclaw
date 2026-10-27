import { describe, expect, it } from "vitest";
import type { QaParitySuiteSummary } from "./agentic-parity-report.js";
import type { RuntimeId } from "./runtime-id.js";
import type { RuntimeParityResult } from "./runtime-parity.js";
import { readQaScenarioPack, type QaSeedScenarioWithSource } from "./scenario-catalog.js";
import {
  buildQaToolCoverageReport,
  renderQaToolCoverageMarkdownReport,
} from "./tool-coverage-report.js";

const TEST_TOOL_COVERAGE_ID = "agents.tool-call-handling";
const NATIVE_COVERAGE = {
  bucket: "codex-native-workspace",
  expectedLayer: "codex-native-workspace",
  capabilityLayer: "codex-native-workspace",
  required: true,
};
type ScenarioConfig = { toolCoverage?: Record<string, unknown>; [key: string]: unknown };

function makeScenario(
  id: string,
  tool: string,
  config: ScenarioConfig = {},
): QaSeedScenarioWithSource {
  return {
    id,
    title: id,
    surface: "runtime-tools",
    coverage: { primary: [TEST_TOOL_COVERAGE_ID] },
    objective: "exercise tool",
    successCriteria: ["tool is exercised"],
    sourcePath: `qa/scenarios/runtime/tools/${tool}.yaml`,
    execution: {
      kind: "flow",
      config: {
        ...config,
        toolCoverage: { ...config.toolCoverage, family: tool },
      },
      flow: { steps: [{ name: "noop", actions: [{ assert: "true" }] }] },
    },
  };
}

function makeRequiredToolScenario(tool: string, toolName: string) {
  return makeScenario(`tool-${tool}`, tool, {
    toolName,
    toolCoverage: {
      bucket: "openclaw-dynamic-integration",
      expectedLayer: "openclaw-dynamic",
      capabilityLayer: "openclaw-dynamic-direct",
      required: true,
    },
  });
}

function makeCell(
  runtime: RuntimeId,
  overrides: Partial<RuntimeParityResult["cells"][RuntimeId]>,
): RuntimeParityResult["cells"][RuntimeId] {
  return {
    runtime,
    status: "pass",
    transcriptBytes: "",
    toolCalls: [],
    finalText: "",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    wallClockMs: 1,
    bootStateLines: [],
    ...overrides,
  };
}

function call(tool: string, resultHash = "r", argsHash = "a") {
  return { tool, argsHash, resultHash };
}

function result(
  scenarioId: string,
  drift: RuntimeParityResult["drift"],
  openclawCalls: RuntimeParityResult["cells"][RuntimeId]["toolCalls"],
  codexCalls = openclawCalls,
  driftDetails?: string,
): RuntimeParityResult {
  return {
    scenarioId,
    drift,
    ...(driftDetails ? { driftDetails } : {}),
    cells: {
      openclaw: makeCell("openclaw", { toolCalls: openclawCalls }),
      codex: makeCell("codex", { toolCalls: codexCalls }),
    },
  };
}

function summary(...results: RuntimeParityResult[]): QaParitySuiteSummary {
  return {
    scenarios: results.map((runtimeParity) => ({
      name: runtimeParity.scenarioId,
      status: runtimeParity.drift === "none" ? "pass" : "fail",
      runtimeParity,
    })),
  };
}

function makeReport(scenarios: QaSeedScenarioWithSource[], suite?: QaParitySuiteSummary) {
  return buildQaToolCoverageReport({ scenarios, summary: suite });
}

function evaluate(scenario: QaSeedScenarioWithSource, parity: RuntimeParityResult) {
  return makeReport([scenario], summary(parity));
}

describe("qa tool coverage report", () => {
  it("renders catalog-only tool fixture coverage", () => {
    const report = makeReport([
      makeScenario("tool-read", "read", { toolCoverage: NATIVE_COVERAGE }),
    ]);

    expect(report.evaluated).toBe(false);
    expect(report.rows).toHaveLength(1);
    expect(renderQaToolCoverageMarkdownReport(report)).toContain(
      "| read | codex-native-workspace | codex-native-workspace | codex-native-workspace | yes | 1 | not-run | not-run | not-run |",
    );
  });

  it("escapes freeform metadata in the markdown table", () => {
    const report = makeReport([
      makeScenario("tool-read", "read|file", {
        toolCoverage: {
          ...NATIVE_COVERAGE,
          tracking: "#80236",
          reason: String.raw`tracked \| runtime drift`,
          codexDefaultImpact: "P2 | default",
          qaImpact: "P1 | confidence",
          action: "fix | backfill",
        },
      }),
    ]);

    const markdown = renderQaToolCoverageMarkdownReport(report);

    expect(markdown).toContain("read\\|file");
    expect(markdown).toContain("P2 \\| default");
    expect(markdown).toContain("P1 \\| confidence");
    expect(markdown).toContain("fix \\| backfill");
    expect(markdown).toContain(String.raw`#80236 tracked \\\| runtime drift`);
  });

  it("retains tracking metadata on accepted result-shape drift", () => {
    const report = makeReport(
      [
        makeScenario("tool-read", "read"),
        makeScenario("tool-write", "write", {
          toolCoverage: {
            bucket: "codex-native-workspace",
            expectedLayer: "codex-native-workspace",
            required: true,
          },
          knownBroken: { issue: "#80236", reason: "tracked runtime drift" },
        }),
      ],
      {
        ...summary(
          result("tool-read", "none", [call("read")]),
          result(
            "tool-write",
            "tool-result-shape",
            [call("write", "r1")],
            [call("write", "r2")],
            "tool result differs",
          ),
        ),
        run: { runtimePair: ["openclaw", "codex"] },
      },
    );

    expect(report).toMatchObject({ pass: true, passingTools: 2, trackedTools: 1 });
    expect(report.rows.find((row) => row.tool === "write")).toMatchObject({
      drift: "tool-result-shape",
      tracking: "#80236 tracked runtime drift",
    });
  });

  it("keeps searchable OpenClaw dynamic tool rows report-only by default", () => {
    const report = evaluate(
      makeScenario("tool-searchable-web-search", "web-search", {
        toolName: "web_search",
        toolCoverage: {
          bucket: "openclaw-dynamic-integration",
          expectedLayer: "openclaw-dynamic",
          capabilityLayer: "openclaw-dynamic-searchable",
        },
      }),
      result("tool-searchable-web-search", "tool-call-shape", [call("web_search")], []),
    );

    expect(report).toMatchObject({
      pass: true,
      failures: [],
      reportOnlyTools: 1,
      passingTools: 0,
      searchableDynamicTools: 1,
    });
    expect(report.rows[0]).toMatchObject({
      capabilityLayer: "openclaw-dynamic-searchable",
      required: false,
      drift: "tool-call-shape",
    });
  });

  it("counts Codex-native workspace receipts under their native tool names", () => {
    const report = evaluate(
      makeScenario("tool-exec", "exec", {
        toolName: "exec",
        nativeWorkspaceBehavior: "exec",
        toolCoverage: NATIVE_COVERAGE,
      }),
      result(
        "tool-exec",
        "tool-call-shape",
        [call("exec", "openclaw-ok")],
        [call("bash", "codex-ok", "b")],
      ),
    );

    expect(report).toMatchObject({ pass: true, failures: [] });
    expect(report.rows[0]).toMatchObject({
      runtimeToolName: "exec",
      codexRuntimeToolName: "bash",
      openclawSuccessfulToolCalls: 1,
      codexSuccessfulToolCalls: 1,
    });
  });

  it("does not count error or unlinked results as successful required tool evidence", () => {
    const report = evaluate(
      makeRequiredToolScenario("web-search", "web_search"),
      result(
        "tool-web-search",
        "tool-result-shape",
        [call("web_search", "ok")],
        [
          { ...call("web_search", "error"), errorClass: "tool-result-error" },
          call("web_search", "", "b"),
        ],
      ),
    );

    expect(report.rows[0]).toMatchObject({ codexToolCalls: 2, codexSuccessfulToolCalls: 0 });
    expect(report).toMatchObject({
      pass: false,
      passingTools: 0,
      failures: ["web-search missing successful codex tool call/result web_search"],
    });
  });

  it("does not let skipped execution hide a runtime cell failure", () => {
    const skipped = result(
      "tool-web-fetch",
      "failure-mode",
      [call("web_fetch", "ok")],
      undefined,
      "runtime-pair cell status differs (pass vs skip)",
    );
    skipped.cells.codex = {
      ...skipped.cells.codex,
      status: "skip",
      runtimeErrorClass: "capture-missing",
    };
    const report = makeReport([makeRequiredToolScenario("web-fetch", "web_fetch")], {
      scenarios: [{ name: "tool web_fetch", status: "skip", runtimeParity: skipped }],
    });

    expect(report.rows[0]).toMatchObject({ openclaw: "pass", codex: "fail" });
    expect(report.failures).toEqual(["web-fetch status openclaw=pass codex=fail"]);
  });

  it.each([
    [
      "preserved failure mode",
      summary(
        result(
          "tool-web-search",
          "failure-mode",
          [call("web_search")],
          undefined,
          "at least one runtime failed",
        ),
      ),
      "web-search drift=failure-mode (at least one runtime failed)",
    ],
    ["missing execution", summary(), "web-search drift=not-run"],
  ] as const)("fails required dynamic coverage for %s", (_name, suite, failure) => {
    const report = makeReport([makeRequiredToolScenario("web-search", "web_search")], suite);
    expect(report).toMatchObject({ pass: false, failures: [failure] });
  });

  it("rejects unknown runtime capability layers", () => {
    expect(() =>
      makeReport([
        makeScenario("tool-bad-layer", "bad", {
          toolCoverage: {
            bucket: "openclaw-dynamic-integration",
            capabilityLayer: "everything-everywhere",
          },
        }),
      ]),
    ).toThrow("unknown runtime tool capabilityLayer");
  });

  it("discovers the runtime tool fixture catalog", () => {
    const report = makeReport(readQaScenarioPack().scenarios);
    const applyPatchRow = report.rows.find((row) => row.tool === "apply-patch");
    expect(applyPatchRow).toMatchObject({
      bucket: "codex-native-workspace",
      expectedLayer: "codex-native-workspace",
      required: true,
    });
    expect(applyPatchRow?.tracking).toBeUndefined();
    expect(report.rows.find((row) => row.tool === "sessions_spawn")).toMatchObject({
      capabilityLayer: "openclaw-dynamic-direct",
      required: true,
      action: expect.stringContaining("hard gate"),
    });
    expect(report.rows.find((row) => row.tool === "sessions_spawn")?.tracking).toBeUndefined();
    expect(report.rows.find((row) => row.tool === "message-tool")).toMatchObject({
      bucket: "optional-profile-or-plugin",
      expectedLayer: "profile-or-plugin",
      required: false,
      action: "keep report-only in coding profile",
    });
    expect(report.rows.find((row) => row.tool === "image_generate")).toMatchObject({
      bucket: "openclaw-dynamic-integration",
      capabilityLayer: "openclaw-dynamic-searchable",
      expectedLayer: "openclaw-dynamic",
      required: false,
    });
    expect(report.rows.find((row) => row.tool === "web_search")).toMatchObject({
      bucket: "openclaw-dynamic-integration",
      capabilityLayer: "openclaw-dynamic-searchable",
      required: true,
    });
    expect(report.rows.find((row) => row.tool === "web_search")?.tracking).toBeUndefined();
  });
});
