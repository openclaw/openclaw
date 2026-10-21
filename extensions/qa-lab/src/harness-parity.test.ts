import { describe, expect, it } from "vitest";
import {
  classifyHarnessParityDrift,
  type HarnessRuntimeParityCell,
  type RuntimeParitySystemPromptReport,
} from "./harness-parity.js";
import type { RuntimeParityComparisonMode } from "./runtime-tool-metadata.js";

type CellOverrides = Partial<HarnessRuntimeParityCell>;
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
  return classifyHarnessParityDrift({
    left: makeCell(left),
    right: makeCell(right),
    ...(comparisonMode ? { comparisonMode } : {}),
  });
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
      ["tool-description", toolReport({ summaryChars: 10 })],
      ["tool-schema", toolReport({ schemaHash: "schema-b" })],
      ["tool-schema", promptReport({ tools: { ...BASE_PROMPT_REPORT.tools, schemaChars: 22 } })],
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
    expect(
      classify(
        {},
        {
          ...toolReport({ schemaHash: "changed" }),
          transportErrorClass: "transport",
          runtimeErrorClass: "runtime",
        },
      ),
    ).toBe("failure-mode");
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
});
