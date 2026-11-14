import { expect, it } from "vitest";
import {
  classifyHarnessParityDrift,
  type HarnessRuntimeParityCell,
  type RuntimeParitySystemPromptReport,
} from "./harness-parity.js";

type Cell = Partial<HarnessRuntimeParityCell>;
const text = '{"message":{"role":"assistant","content":"same"}}\n';
const tool = { name: "read", summaryHash: "base", schemaHash: "base" };
const report = {
  systemPrompt: { hash: "base" },
  skills: { hash: "base" },
  tools: { entries: [tool] },
};
function classify(left: Cell, right: Cell) {
  const cell = (overrides: Cell): HarnessRuntimeParityCell => ({
    runtime: "openclaw",
    transcriptBytes: text,
    toolCalls: [],
    finalText: "same",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    wallClockMs: 1,
    bootStateLines: [],
    systemPromptReport: report,
    ...overrides,
  });
  return classifyHarnessParityDrift({ left: cell(left), right: cell(right) });
}
function tools(
  entry: NonNullable<NonNullable<RuntimeParitySystemPromptReport["tools"]>["entries"]>[number],
) {
  return { tools: { entries: [entry] } };
}

it.each([
  ["system-prompt", { systemPrompt: { hash: "changed" } }],
  ["system-prompt", { skills: { hash: "changed" } }],
  ["tool-description", tools({ ...tool, summaryHash: "changed" })],
  ["tool-description", tools({ name: "read", summaryChars: 9 })],
  ["tool-schema", tools({ ...tool, schemaHash: "changed" })],
] as const)("prioritizes %s surface drift over tool calls", (drift, changed) => {
  expect(
    classify(
      {},
      {
        systemPromptReport: { ...report, ...changed },
        toolCalls: [{ tool: "bash", argsHash: "changed", resultHash: "changed" }],
      },
    ),
  ).toBe(drift);
});

it("classifies behavioral harness drift and ignores transcript metadata", () => {
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
          '{"type":"model_change","modelId":"model"}\n' +
          '{"type":"thinking_level_change","thinkingLevel":"off"}\n' +
          '{"type":"custom","customType":"model-snapshot"}\n' +
          text,
      },
      {},
    ),
  ).toBe("none");
  for (const message of [
    '{"message":{"role":"assistant"}}\n',
    '{"role":"assistant","content":"same"}\n',
  ]) {
    expect(
      classify(
        { transcriptBytes: message },
        {
          transcriptBytes: message + '{"role":"tool","content":"same"}\n',
        },
      ),
    ).toBe("structural");
  }
  expect(classify({ runtimeErrorClass: "timeout" }, {})).toBe("failure-mode");
  expect(
    classify(
      {},
      {
        systemPromptReport: { ...report, ...tools({ ...tool, schemaHash: "changed" }) },
        transportErrorClass: "transport",
        runtimeErrorClass: "runtime",
      },
    ),
  ).toBe("failure-mode");
});
