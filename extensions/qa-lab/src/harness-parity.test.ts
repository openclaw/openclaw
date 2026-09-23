// Qa Lab tests cover harness parity plugin behavior.
import { describe, expect, it } from "vitest";
import {
  buildHarnessParityCell,
  buildHarnessParityResult,
  type HarnessRuntimeParityCell,
} from "./harness-parity.js";
import type { RuntimeId } from "./runtime-parity.js";
import type { RuntimeParityComparisonMode } from "./runtime-tool-metadata.js";

type HarnessVariant = Parameters<typeof buildHarnessParityCell>[0]["variant"];

const LEFT: HarnessVariant = { id: "left", label: "Left", runtime: "openclaw" };
const RIGHT: HarnessVariant = { id: "right", label: "Right", runtime: "openclaw" };

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

function makeCell(
  runtime: RuntimeId,
  overrides: Partial<HarnessRuntimeParityCell> = {},
): HarnessRuntimeParityCell {
  return {
    runtime,
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
  comparisonMode?: RuntimeParityComparisonMode,
) {
  return buildHarnessParityResult({
    scenarioId: "scenario",
    left: buildHarnessParityCell({
      variant: LEFT,
      cell: makeCell("openclaw", left),
      tokenUsageSource: "live-usage",
    }),
    right: buildHarnessParityCell({
      variant: RIGHT,
      cell: makeCell("openclaw", right),
      tokenUsageSource: "live-usage",
    }),
    ...(comparisonMode ? { comparisonMode } : {}),
  }).drift;
}

describe("harness parity", () => {
  it("classifies prompt and tool surface drift before behavioral drift", () => {
    expect(
      classify(
        {},
        {
          systemPromptReport: {
            ...BASE_PROMPT_REPORT,
            systemPrompt: { chars: 101, projectContextChars: 40, nonProjectContextChars: 61 },
          },
        },
      ),
    ).toBe("system-prompt");
    expect(
      classify(
        {},
        {
          systemPromptReport: {
            ...BASE_PROMPT_REPORT,
            systemPrompt: {
              chars: 100,
              projectContextChars: 40,
              nonProjectContextChars: 60,
              hash: "system-b",
            },
          },
        },
      ),
    ).toBe("system-prompt");
    expect(
      classify(
        {},
        {
          systemPromptReport: {
            ...BASE_PROMPT_REPORT,
            skills: { promptChars: 12, hash: "skills-b" },
          },
        },
      ),
    ).toBe("system-prompt");
    expect(
      classify(
        {},
        {
          systemPromptReport: {
            ...BASE_PROMPT_REPORT,
            tools: {
              schemaChars: 20,
              entries: [
                {
                  name: "read",
                  summaryChars: 8,
                  summaryHash: "summary-b",
                  schemaChars: 20,
                  schemaHash: "schema-a",
                  propertiesCount: 1,
                },
              ],
            },
          },
        },
      ),
    ).toBe("tool-description");
    expect(
      classify(
        {},
        {
          systemPromptReport: {
            ...BASE_PROMPT_REPORT,
            tools: {
              schemaChars: 20,
              entries: [
                {
                  name: "read",
                  summaryChars: 8,
                  summaryHash: "summary-a",
                  schemaChars: 20,
                  schemaHash: "schema-b",
                  propertiesCount: 1,
                },
              ],
            },
          },
        },
      ),
    ).toBe("tool-schema");
  });

  it("classifies behavioral harness drift", () => {
    expect(
      classify(
        { toolCalls: [{ tool: "read", argsHash: "a", resultHash: "r" }] },
        { toolCalls: [{ tool: "read", argsHash: "b", resultHash: "r" }] },
      ),
    ).toBe("tool-call-shape");
    expect(
      classify(
        { toolCalls: [{ tool: "read", argsHash: "a", resultHash: "r1" }] },
        { toolCalls: [{ tool: "read", argsHash: "a", resultHash: "r2" }] },
      ),
    ).toBe("tool-result-shape");
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
    expect(
      classify(
        { transcriptBytes: '{"message":{"role":"assistant"}}\n' },
        { transcriptBytes: '{"message":{"role":"assistant"}}\n{"message":{"role":"tool"}}\n' },
      ),
    ).toBe("structural");
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
          systemPromptReport: {
            ...BASE_PROMPT_REPORT,
            systemPrompt: { chars: 101, projectContextChars: 40, nonProjectContextChars: 61 },
          },
          toolCalls: [{ tool: "bash", argsHash: "changed", resultHash: "changed" }],
        },
        "codex-native-workspace",
      ),
    ).toBe("system-prompt");
    expect(
      classify(
        {},
        {
          systemPromptReport: {
            ...BASE_PROMPT_REPORT,
            tools: {
              schemaChars: 20,
              entries: [{ name: "read", summaryChars: 9, schemaChars: 20, propertiesCount: 1 }],
            },
          },
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
    const source = makeCell("openclaw", {
      toolCalls: [{ tool: "read", argsHash: "a", resultHash: "r" }],
    });
    const leftCell = buildHarnessParityCell({
      variant: LEFT,
      cell: source,
      tokenUsageSource: "live-usage",
    });
    const rightCell = buildHarnessParityCell({
      variant: RIGHT,
      cell: {
        ...source,
        transcriptBytes: '{"type":"metadata"}\n' + source.transcriptBytes,
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        ...right,
      },
      tokenUsageSource: "live-usage",
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
    const sourceCell = makeCell("openclaw", {
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
