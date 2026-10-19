import { describe, expect, it } from "vitest";
import {
  buildHarnessParityCell,
  buildHarnessParityResult,
  type HarnessRuntimeParityCell,
  type RuntimeParitySystemPromptReport,
} from "./harness-parity.js";
import type { RuntimeParityComparisonMode } from "./runtime-tool-metadata.js";

type HarnessVariant = Parameters<typeof buildHarnessParityCell>[0]["variant"];
type CellOverrides = Partial<HarnessRuntimeParityCell>;

const LEFT: HarnessVariant = { id: "left", label: "Left", runtime: "openclaw" };
const RIGHT: HarnessVariant = { id: "right", label: "Right", runtime: "openclaw" };
const ASSISTANT = '{"message":{"role":"assistant"}}\n';
const TOOL = '{"message":{"role":"tool"}}\n';
const TEXT = '{"message":{"role":"assistant","content":"same"}}\n';
const FLAT_TEXT = '{"role":"assistant","content":"same"}\n';

const BASE_PROMPT_REPORT = {
  systemPrompt: {
    chars: 100,
    projectContextChars: 40,
    nonProjectContextChars: 60,
    hash: "system-a",
  },
  skills: { promptChars: 12, hash: "skills-a" },
  tools: {
    schemaChars: 20,
    entries: [
      {
        name: "read",
        summaryChars: 8,
        summaryHash: "summary-a",
        schemaChars: 20,
        schemaHash: "schema-a",
        propertiesCount: 1,
      },
    ],
  },
};

function makeCell(overrides: CellOverrides = {}): HarnessRuntimeParityCell {
  return {
    runtime: "openclaw",
    transcriptBytes: TEXT,
    toolCalls: [],
    finalText: "same",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    wallClockMs: 1,
    bootStateLines: [],
    systemPromptReport: BASE_PROMPT_REPORT,
    ...overrides,
  };
}

function classify(
  left: CellOverrides,
  right: CellOverrides,
  comparisonMode?: RuntimeParityComparisonMode,
) {
  return buildHarnessParityResult({
    scenarioId: "scenario",
    left: liveCell(LEFT, makeCell(left)),
    right: liveCell(RIGHT, makeCell(right)),
    ...(comparisonMode ? { comparisonMode } : {}),
  }).drift;
}

function liveCell(variant: HarnessVariant, cell: HarnessRuntimeParityCell) {
  return buildHarnessParityCell({ variant, cell, tokenUsageSource: "live-usage" });
}

function promptReport(overrides: RuntimeParitySystemPromptReport) {
  return { systemPromptReport: { ...BASE_PROMPT_REPORT, ...overrides } };
}

function toolReport(overrides: Partial<(typeof BASE_PROMPT_REPORT.tools.entries)[number]>) {
  return promptReport({
    tools: { schemaChars: 20, entries: [{ ...BASE_PROMPT_REPORT.tools.entries[0], ...overrides }] },
  });
}

describe("harness parity", () => {
  it("classifies prompt and tool surface drift before behavioral drift", () => {
    for (const [drift, right] of [
      [
        "system-prompt",
        promptReport({
          systemPrompt: { chars: 101, projectContextChars: 40, nonProjectContextChars: 61 },
        }),
      ],
      [
        "system-prompt",
        promptReport({ systemPrompt: { ...BASE_PROMPT_REPORT.systemPrompt, hash: "system-b" } }),
      ],
      ["system-prompt", promptReport({ skills: { promptChars: 12, hash: "skills-b" } })],
      ["tool-description", toolReport({ summaryHash: "summary-b" })],
      ["tool-schema", toolReport({ schemaHash: "schema-b" })],
    ] as const) {
      expect(classify({}, right)).toBe(drift);
    }
  });

  it("classifies behavioral harness drift", () => {
    const call = (argsHash: string, resultHash: string) => ({
      toolCalls: [{ tool: "read", argsHash, resultHash }],
    });
    expect(classify(call("a", "r"), call("b", "r"))).toBe("tool-call-shape");
    expect(classify(call("a", "r1"), call("a", "r2"))).toBe("tool-result-shape");
    expect(classify({ finalText: "same text" }, { finalText: "different text" })).toBe("text-only");
    expect(
      classify(
        {
          transcriptBytes:
            '{"type":"model_change","modelId":"gpt-5.6-luna"}\n' +
            '{"type":"thinking_level_change","thinkingLevel":"off"}\n' +
            '{"type":"custom","customType":"model-snapshot"}\n' +
            TEXT,
        },
        { transcriptBytes: TEXT },
      ),
    ).toBe("none");
    for (const [left, right] of [
      [ASSISTANT, ASSISTANT + TOOL],
      [FLAT_TEXT, FLAT_TEXT + '{"role":"tool","content":"same"}\n'],
    ]) {
      expect(classify({ transcriptBytes: left }, { transcriptBytes: right })).toBe("structural");
    }
    expect(classify({ runtimeErrorClass: "timeout" }, {})).toBe("failure-mode");
  });

  it("honors native workspace comparison mode for outcome-only harness proofs", () => {
    expect(
      classify(
        {
          transcriptBytes:
            '{"message":{"role":"assistant","content":"same"}}\n' +
            '{"message":{"role":"tool","content":"same result"}}\n',
          toolCalls: [{ tool: "bash", argsHash: "sed-160", resultHash: "same-result" }],
        },
        {
          transcriptBytes: '{"message":{"role":"assistant","content":"same"}}\n',
          toolCalls: [{ tool: "bash", argsHash: "sed-200", resultHash: "same-result" }],
        },
        "codex-native-workspace",
      ),
    ).toBe("none");

    expect(
      classify(
        { toolCalls: [{ tool: "bash", argsHash: "a", resultHash: "r1" }] },
        { toolCalls: [{ tool: "bash", argsHash: "b", resultHash: "r2" }] },
        "outcome-only",
      ),
    ).toBe("none");
  });

  it("keeps prompt and tool surface checks strict under native workspace comparison mode", () => {
    expect(
      classify(
        {},
        {
          ...promptReport({
            systemPrompt: { chars: 101, projectContextChars: 40, nonProjectContextChars: 61 },
          }),
          toolCalls: [{ tool: "bash", argsHash: "changed", resultHash: "changed" }],
        },
        "codex-native-workspace",
      ),
    ).toBe("system-prompt");
    expect(
      classify(
        {},
        {
          ...promptReport({
            tools: {
              schemaChars: 20,
              entries: [{ name: "read", summaryChars: 9, schemaChars: 20, propertiesCount: 1 }],
            },
          }),
          toolCalls: [{ tool: "bash", argsHash: "changed", resultHash: "changed" }],
        },
        "outcome-only",
      ),
    ).toBe("tool-description");
  });

  it.each([
    {
      drift: "failure-mode",
      right: { transportErrorClass: "transport", runtimeErrorClass: "runtime" },
      details: "at least one harness variant hit a transport failure",
    },
    {
      drift: "system-prompt",
      right: {
        systemPromptReport: {
          ...BASE_PROMPT_REPORT,
          systemPrompt: { ...BASE_PROMPT_REPORT.systemPrompt, chars: 101 },
        },
      },
      details: "system prompt report differs",
      promptDelta: { systemPromptChars: 1 },
    },
    {
      drift: "tool-description",
      right: {
        systemPromptReport: {
          ...BASE_PROMPT_REPORT,
          tools: {
            ...BASE_PROMPT_REPORT.tools,
            entries: [{ ...BASE_PROMPT_REPORT.tools.entries[0], summaryChars: 10 }],
          },
        },
      },
      details: "tool description summary shape differs",
      promptDelta: { toolSummaryChars: 2 },
    },
    {
      drift: "tool-schema",
      right: {
        systemPromptReport: {
          ...BASE_PROMPT_REPORT,
          tools: { ...BASE_PROMPT_REPORT.tools, schemaChars: 22 },
        },
      },
      details: "tool schema shape differs",
      promptDelta: { toolSchemaChars: 2 },
    },
    {
      drift: "tool-call-shape",
      right: { toolCalls: [{ tool: "read", argsHash: "b", resultHash: "r" }] },
      details: "tool call 1 differs (read/a vs read/b)",
    },
    {
      drift: "tool-result-shape",
      right: { toolCalls: [{ tool: "read", argsHash: "a", resultHash: "changed" }] },
      details: "tool result 1 differs (read)",
    },
    {
      drift: "structural",
      right: {
        transcriptBytes: '{"role":"assistant"}\n{"role":"tool"}\n',
      },
      details: "transcript/final-text structure differs (1 message records vs 2 message records)",
    },
    {
      drift: "text-only",
      right: { finalText: "different" },
      details: "final text differs after whitespace normalization",
    },
    { drift: "none", right: {} },
  ])("keeps complete result metadata for $drift", ({ drift, right, details, promptDelta }) => {
    const source = makeCell({ toolCalls: [{ tool: "read", argsHash: "a", resultHash: "r" }] });
    const leftCell = liveCell(LEFT, source);
    const rightCell = liveCell(RIGHT, {
      ...source,
      transcriptBytes: '{"type":"metadata"}\n' + source.transcriptBytes,
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      ...right,
    });

    expect(
      buildHarnessParityResult({ scenarioId: "metadata", left: leftCell, right: rightCell }),
    ).toStrictEqual({
      scenarioId: "metadata",
      left: leftCell,
      right: rightCell,
      drift,
      ...(drift === "none" ? {} : { driftDetails: details, firstDriftTurn: 1 }),
      promptDelta: {
        systemPromptChars: 0,
        projectContextChars: 0,
        skillPromptChars: 0,
        toolSummaryChars: 0,
        toolSchemaChars: 0,
        toolCount: 0,
        ...promptDelta,
      },
      tokenDeltaPercent: 100,
    });
  });

  it("labels mock token estimates separately from live usage", () => {
    const sourceCell = makeCell({ usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
    const cell = buildHarnessParityCell({
      variant: LEFT,
      cell: sourceCell,
      tokenUsageSource: "mock-estimate",
    });
    const inputChars = 100 + 12 + 8 + 20 + sourceCell.transcriptBytes.length;

    expect(cell.tokenUsage.totalTokens).toBeGreaterThan(0);
    expect(cell).toMatchObject({
      tokenUsageSource: "mock-estimate",
      tokenUsage: { inputTokens: Math.ceil(inputChars / 4) },
      promptStats: { toolCount: 1 },
    });
  });
});
