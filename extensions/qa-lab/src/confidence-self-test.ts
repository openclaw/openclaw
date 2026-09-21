import fs from "node:fs/promises";
import path from "node:path";
import {
  escapeTableCell,
  evaluateJsonlReplaySummary,
  type QaConfidenceVerdict,
} from "./confidence-report.js";
import {
  buildHarnessParityCell,
  buildHarnessParityResult,
  type HarnessParityDrift,
  type HarnessRuntimeParityCell,
  type RuntimeParitySystemPromptReport,
} from "./harness-parity.js";
import {
  runRuntimeParityScenario,
  type RuntimeParityCell,
  type RuntimeParityDrift,
  type RuntimeParityResult,
  type RuntimeParityToolCall,
} from "./runtime-parity.js";
import { buildTokenEfficiencyReport } from "./token-efficiency-report.js";

type QaConfidenceSelfTestCanary = {
  id: string;
  category:
    | "prompt"
    | "tool-schema"
    | "tool-call"
    | "tool-result"
    | "failure-mode"
    | "token-efficiency"
    | "jsonl-replay";
  detected: boolean;
  expectedVerdict: Exclude<QaConfidenceVerdict, "pass" | "environment-blocked">;
  details: string;
};

type QaConfidenceSelfTestSummary = {
  generatedAt: string;
  pass: boolean;
  canaries: QaConfidenceSelfTestCanary[];
};

function syntheticRuntimeCell(
  runtime: RuntimeParityCell["runtime"],
  overrides: Partial<HarnessRuntimeParityCell> = {},
): HarnessRuntimeParityCell {
  return {
    runtime,
    transcriptBytes: JSON.stringify({ message: { role: "assistant", content: "ok" } }),
    toolCalls: [],
    finalText: "ok",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    },
    wallClockMs: 10,
    bootStateLines: [],
    ...overrides,
  };
}

function syntheticToolCall(overrides: Partial<RuntimeParityToolCall> = {}): RuntimeParityToolCall {
  return {
    tool: "openclaw.synthetic",
    argsHash: "args-a",
    resultHash: "result-a",
    ...overrides,
  };
}

async function detectRuntimeDrift(params: {
  scenarioId: string;
  openclaw: RuntimeParityCell;
  codex: RuntimeParityCell;
  expectedDrift: RuntimeParityDrift;
}): Promise<boolean> {
  const result = await runRuntimeParityScenario({
    scenarioId: params.scenarioId,
    runCell: async (runtime) => ({
      status: "pass",
      cell: runtime === "openclaw" ? params.openclaw : params.codex,
    }),
  });
  return result.drift === params.expectedDrift;
}

function syntheticPromptReport(
  overrides: Partial<RuntimeParitySystemPromptReport> = {},
): RuntimeParitySystemPromptReport {
  return {
    systemPrompt: {
      chars: 100,
      projectContextChars: 10,
      nonProjectContextChars: 90,
      hash: "system-prompt-a",
    },
    skills: {
      promptChars: 20,
      hash: "skills-a",
    },
    tools: {
      listChars: 30,
      schemaChars: 40,
      entries: [
        {
          name: "openclaw.synthetic",
          summaryChars: 12,
          summaryHash: "summary-a",
          schemaChars: 18,
          schemaHash: "schema-a",
          propertiesCount: 2,
        },
      ],
    },
    ...overrides,
  };
}

function detectHarnessDrift(params: {
  leftReport: RuntimeParitySystemPromptReport;
  rightReport: RuntimeParitySystemPromptReport;
  expectedDrift: HarnessParityDrift;
}): boolean {
  const left = buildHarnessParityCell({
    variant: { id: "left", label: "Left" },
    cell: syntheticRuntimeCell("openclaw", { systemPromptReport: params.leftReport }),
    tokenUsageSource: "mock-estimate",
  });
  const right = buildHarnessParityCell({
    variant: { id: "right", label: "Right" },
    cell: syntheticRuntimeCell("codex", { systemPromptReport: params.rightReport }),
    tokenUsageSource: "mock-estimate",
  });
  return (
    buildHarnessParityResult({
      scenarioId: "confidence-self-test",
      left,
      right,
    }).drift === params.expectedDrift
  );
}

function detectTokenEfficiencyRegression(): boolean {
  const openclaw = syntheticRuntimeCell("openclaw", {
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
  });
  const codex = syntheticRuntimeCell("codex", {
    usage: { inputTokens: 200, outputTokens: 40, totalTokens: 240 },
  });
  const runtimeParity: RuntimeParityResult = {
    scenarioId: "token-efficiency-regression",
    cells: {
      openclaw: { ...openclaw, status: "pass" },
      codex: { ...codex, status: "pass" },
    },
    drift: "none",
  };
  const report = buildTokenEfficiencyReport({
    summary: {
      run: {
        providerMode: "live-frontier",
        runtimePair: ["openclaw", "codex"],
      },
      scenarios: [
        {
          name: "token-efficiency-regression",
          status: "pass",
          runtimeParity,
        },
      ],
    },
    thresholdPercent: 15,
    generatedAt: "2026-05-12T00:00:00.000Z",
  });
  return !report.pass && report.failures.length === 1;
}

function detectJsonlReplayDrift(): boolean {
  const evaluation = evaluateJsonlReplaySummary({
    transcripts: [
      {
        transcriptPath: "synthetic.jsonl",
        userTurnCount: 2,
        cells: { openclaw: [{}, {}], codex: [{}, {}] },
        drift: ["none", "tool-result-shape"],
        firstDriftAtTurn: 2,
      },
    ],
  });
  return !evaluation.passed && evaluation.status !== "unknown";
}

async function buildQaConfidenceSelfTestSummary(
  generatedAt = new Date().toISOString(),
): Promise<QaConfidenceSelfTestSummary> {
  const promptDriftDetected = detectHarnessDrift({
    leftReport: syntheticPromptReport(),
    rightReport: syntheticPromptReport({
      systemPrompt: {
        chars: 100,
        projectContextChars: 10,
        nonProjectContextChars: 90,
        hash: "system-prompt-b",
      },
    }),
    expectedDrift: "system-prompt",
  });
  const toolDescriptionDetected = detectHarnessDrift({
    leftReport: syntheticPromptReport(),
    rightReport: syntheticPromptReport({
      tools: {
        listChars: 30,
        schemaChars: 40,
        entries: [
          {
            name: "openclaw.synthetic",
            summaryChars: 12,
            summaryHash: "summary-b",
            schemaChars: 18,
            schemaHash: "schema-a",
            propertiesCount: 2,
          },
        ],
      },
    }),
    expectedDrift: "tool-description",
  });
  const toolSchemaDetected = detectHarnessDrift({
    leftReport: syntheticPromptReport(),
    rightReport: syntheticPromptReport({
      tools: {
        listChars: 30,
        schemaChars: 40,
        entries: [
          {
            name: "openclaw.synthetic",
            summaryChars: 12,
            summaryHash: "summary-a",
            schemaChars: 18,
            schemaHash: "schema-b",
            propertiesCount: 2,
          },
        ],
      },
    }),
    expectedDrift: "tool-schema",
  });
  const runtimeToolCallDropDetected = await detectRuntimeDrift({
    scenarioId: "runtime-tool-call-drop",
    openclaw: syntheticRuntimeCell("openclaw", { toolCalls: [syntheticToolCall()] }),
    codex: syntheticRuntimeCell("codex", { toolCalls: [] }),
    expectedDrift: "tool-call-shape",
  });
  const toolResultMismatchDetected = await detectRuntimeDrift({
    scenarioId: "tool-result-mismatch",
    openclaw: syntheticRuntimeCell("openclaw", { toolCalls: [syntheticToolCall()] }),
    codex: syntheticRuntimeCell("codex", {
      toolCalls: [syntheticToolCall({ resultHash: "result-b" })],
    }),
    expectedDrift: "tool-result-shape",
  });
  const failureModeDriftDetected = await detectRuntimeDrift({
    scenarioId: "failure-mode-drift",
    openclaw: syntheticRuntimeCell("openclaw"),
    codex: syntheticRuntimeCell("codex", { transportErrorClass: "synthetic-transport" }),
    expectedDrift: "failure-mode",
  });
  const canaries: QaConfidenceSelfTestCanary[] = [
    {
      id: "prompt-drift",
      category: "prompt",
      detected: promptDriftDetected,
      expectedVerdict: "qa-harness-bug",
      details: "synthetic harness prompt hash changed",
    },
    {
      id: "tool-description-schema-drift",
      category: "tool-schema",
      detected: toolDescriptionDetected && toolSchemaDetected,
      expectedVerdict: "qa-harness-bug",
      details: "synthetic tool description/schema hash changed",
    },
    {
      id: "runtime-tool-call-drop",
      category: "tool-call",
      detected: runtimeToolCallDropDetected,
      expectedVerdict: "product-bug",
      details: "synthetic runtime transcript omitted a required tool call",
    },
    {
      id: "tool-result-mismatch",
      category: "tool-result",
      detected: toolResultMismatchDetected,
      expectedVerdict: "product-bug",
      details: "synthetic runtime transcript returned a mismatched tool result",
    },
    {
      id: "failure-mode-drift",
      category: "failure-mode",
      detected: failureModeDriftDetected,
      expectedVerdict: "product-bug",
      details: "synthetic runtime failed with a different failure mode",
    },
    {
      id: "token-efficiency-regression",
      category: "token-efficiency",
      detected: detectTokenEfficiencyRegression(),
      expectedVerdict: "qa-harness-bug",
      details: "synthetic token row exceeded the configured efficiency threshold",
    },
    {
      id: "jsonl-replay-ordering-drift",
      category: "jsonl-replay",
      detected: detectJsonlReplayDrift(),
      expectedVerdict: "fixture-bug",
      details: "synthetic JSONL replay drifted after turn ordering changed",
    },
  ];
  return {
    generatedAt,
    pass: canaries.every((canary) => canary.detected),
    canaries,
  };
}

function renderQaConfidenceSelfTestMarkdownReport(summary: QaConfidenceSelfTestSummary): string {
  const lines = [
    "# OpenClaw QA Confidence Self-Test",
    "",
    `- Generated at: ${summary.generatedAt}`,
    `- Verdict: ${summary.pass ? "pass" : "fail"}`,
    "",
    "| Canary | Category | Detected | Expected verdict | Details |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const canary of summary.canaries) {
    lines.push(
      `| ${canary.id} | ${canary.category} | ${canary.detected ? "yes" : "no"} | ${canary.expectedVerdict} | ${escapeTableCell(canary.details)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function writeQaConfidenceSelfTestArtifacts(params: {
  outputDir: string;
  generatedAt?: string;
}): Promise<{ reportPath: string; summaryPath: string; summary: QaConfidenceSelfTestSummary }> {
  await fs.mkdir(params.outputDir, { recursive: true });
  const summary = await buildQaConfidenceSelfTestSummary(params.generatedAt);
  const report = renderQaConfidenceSelfTestMarkdownReport(summary);
  const reportPath = path.join(params.outputDir, "qa-confidence-self-test-report.md");
  const summaryPath = path.join(params.outputDir, "qa-confidence-self-test-summary.json");
  await fs.writeFile(reportPath, report, "utf8");
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return { reportPath, summaryPath, summary };
}
