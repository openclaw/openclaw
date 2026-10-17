import { describe, expect, it } from "vitest";
import {
  buildHarnessParityCell,
  buildHarnessParityResult,
  type HarnessRuntimeParityCell,
  type RuntimeParitySystemPromptReport,
} from "./harness-parity.js";

type HarnessVariant = Parameters<typeof buildHarnessParityCell>[0]["variant"];

const LEFT: HarnessVariant = { id: "left", label: "Left", runtime: "openclaw" };
const RIGHT: HarnessVariant = { id: "right", label: "Right", runtime: "openclaw" };
const ASSISTANT = '{"message":{"role":"assistant"}}\n';
const TOOL = '{"message":{"role":"tool"}}\n';

const BASE_PROMPT_REPORT = {
  systemPrompt: {
    chars: 100,
    projectContextChars: 40,
    nonProjectContextChars: 60,
    hash: "system-a",
  },
  skills: {
    promptChars: 12,
    hash: "skills-a",
  },
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

function makeCell(overrides: Partial<HarnessRuntimeParityCell> = {}): HarnessRuntimeParityCell {
  return {
    runtime: "openclaw",
    transcriptBytes: '{"message":{"role":"assistant","content":"same"}}\n',
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
  left: Partial<HarnessRuntimeParityCell>,
  right: Partial<HarnessRuntimeParityCell>,
) {
  return buildHarnessParityResult({
    scenarioId: "scenario",
    left: liveCell(LEFT, makeCell(left)),
    right: liveCell(RIGHT, makeCell(right)),
  }).drift;
}

function liveCell(variant: HarnessVariant, cell: HarnessRuntimeParityCell) {
  return buildHarnessParityCell({ variant, cell, tokenUsageSource: "live-usage" });
}

function promptReport(overrides: RuntimeParitySystemPromptReport) {
  return { systemPromptReport: { ...BASE_PROMPT_REPORT, ...overrides } };
}

function expectDrift(
  right: Partial<HarnessRuntimeParityCell>,
  drift: ReturnType<typeof classify>,
  left: Partial<HarnessRuntimeParityCell> = {},
) {
  expect(classify(left, right)).toBe(drift);
}

function toolReport(overrides: Partial<(typeof BASE_PROMPT_REPORT.tools.entries)[number]>) {
  return promptReport({
    tools: { schemaChars: 20, entries: [{ ...BASE_PROMPT_REPORT.tools.entries[0], ...overrides }] },
  });
}

describe("harness parity", () => {
  it("classifies prompt and tool surface drift before behavioral drift", () => {
    expectDrift(
      promptReport({
        systemPrompt: { chars: 101, projectContextChars: 40, nonProjectContextChars: 61 },
      }),
      "system-prompt",
    );
    expectDrift(
      promptReport({ systemPrompt: { ...BASE_PROMPT_REPORT.systemPrompt, hash: "system-b" } }),
      "system-prompt",
    );
    expectDrift(promptReport({ skills: { promptChars: 12, hash: "skills-b" } }), "system-prompt");
    expectDrift(toolReport({ summaryHash: "summary-b" }), "tool-description");
    expectDrift(toolReport({ schemaHash: "schema-b" }), "tool-schema");
  });

  it("classifies behavioral harness drift", () => {
    expectDrift(
      { toolCalls: [{ tool: "read", argsHash: "b", resultHash: "r" }] },
      "tool-call-shape",
      { toolCalls: [{ tool: "read", argsHash: "a", resultHash: "r" }] },
    );
    expectDrift(
      { toolCalls: [{ tool: "read", argsHash: "a", resultHash: "r2" }] },
      "tool-result-shape",
      { toolCalls: [{ tool: "read", argsHash: "a", resultHash: "r1" }] },
    );
    expect(classify({ finalText: "same text" }, { finalText: "different text" })).toBe("text-only");
    expect(
      classify(
        {
          transcriptBytes:
            '{"type":"model_change","modelId":"gpt-5.6-luna"}\n' +
            '{"type":"thinking_level_change","thinkingLevel":"off"}\n' +
            '{"type":"custom","customType":"model-snapshot"}\n' +
            '{"message":{"role":"assistant","content":"same"}}\n',
        },
        { transcriptBytes: '{"message":{"role":"assistant","content":"same"}}\n' },
      ),
    ).toBe("none");
    expectDrift({ transcriptBytes: ASSISTANT + TOOL }, "structural", {
      transcriptBytes: ASSISTANT,
    });
    expect(
      classify(
        { transcriptBytes: '{"role":"assistant","content":"same"}\n' },
        {
          transcriptBytes:
            '{"role":"assistant","content":"same"}\n{"role":"tool","content":"same"}\n',
        },
      ),
    ).toBe("structural");
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
    const source = makeCell({
      toolCalls: [{ tool: "read", argsHash: "a", resultHash: "r" }],
    });
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
      driftDetails: details,
      firstDriftTurn: 1,
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
    const sourceCell = makeCell({
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
    const cell = buildHarnessParityCell({
      variant: LEFT,
      cell: sourceCell,
      tokenUsageSource: "mock-estimate",
    });
    const inputChars = 100 + 12 + 8 + 20 + sourceCell.transcriptBytes.length;

    expect(cell.tokenUsageSource).toBe("mock-estimate");
    expect(cell.tokenUsage.totalTokens).toBeGreaterThan(0);
    expect(cell.tokenUsage.inputTokens).toBe(Math.ceil(inputChars / 4));
    expect(cell.promptStats.toolCount).toBe(1);
  });
});
