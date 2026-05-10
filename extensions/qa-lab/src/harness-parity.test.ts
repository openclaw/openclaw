import { describe, expect, it } from "vitest";
import {
  buildHarnessParityCell,
  buildHarnessParityResult,
  type HarnessVariant,
} from "./harness-parity.js";
import type { RuntimeId, RuntimeParityCell } from "./runtime-parity.js";

const LEFT: HarnessVariant = { id: "left", label: "Left", runtime: "pi" };
const RIGHT: HarnessVariant = { id: "right", label: "Right", runtime: "pi" };

const BASE_PROMPT_REPORT = {
  systemPrompt: {
    chars: 100,
    projectContextChars: 40,
    nonProjectContextChars: 60,
  },
  skills: {
    promptChars: 12,
  },
  tools: {
    schemaChars: 20,
    entries: [
      {
        name: "read",
        summaryChars: 8,
        schemaChars: 20,
        propertiesCount: 1,
      },
    ],
  },
};

function makeCell(
  runtime: RuntimeId,
  overrides: Partial<RuntimeParityCell> = {},
): RuntimeParityCell {
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

function classify(left: Partial<RuntimeParityCell>, right: Partial<RuntimeParityCell>) {
  return buildHarnessParityResult({
    scenarioId: "scenario",
    left: buildHarnessParityCell({
      variant: LEFT,
      cell: makeCell("pi", left),
      tokenUsageSource: "live-usage",
    }),
    right: buildHarnessParityCell({
      variant: RIGHT,
      cell: makeCell("pi", right),
      tokenUsageSource: "live-usage",
    }),
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
            tools: {
              schemaChars: 20,
              entries: [{ name: "read", summaryChars: 9, schemaChars: 20, propertiesCount: 1 }],
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
              schemaChars: 21,
              entries: [{ name: "read", summaryChars: 8, schemaChars: 21, propertiesCount: 2 }],
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
        { transcriptBytes: '{"message":{"role":"assistant"}}\n' },
        { transcriptBytes: '{"message":{"role":"assistant"}}\n{"message":{"role":"tool"}}\n' },
      ),
    ).toBe("structural");
    expect(classify({ runtimeErrorClass: "timeout" }, {})).toBe("failure-mode");
  });

  it("labels mock token estimates separately from live usage", () => {
    const cell = buildHarnessParityCell({
      variant: LEFT,
      cell: makeCell("pi", { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }),
      tokenUsageSource: "mock-estimate",
    });

    expect(cell.tokenUsageSource).toBe("mock-estimate");
    expect(cell.tokenUsage.totalTokens).toBeGreaterThan(0);
    expect(cell.promptStats.toolCount).toBe(1);
  });
});
