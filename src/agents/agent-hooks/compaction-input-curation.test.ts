import { describe, expect, it, vi } from "vitest";
import type { JudgmentOutcome } from "../../judgments/types.js";
import type { AgentMessage } from "../runtime/index.js";
import { curateCompactionSummarizerInput } from "./compaction-input-curation.js";

function toolResult(text: string, toolName = "exec"): AgentMessage {
  return {
    role: "toolResult",
    toolName,
    toolCallId: "call-1",
    content: [{ type: "text", text }],
  } as AgentMessage;
}

function assistant(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }] } as AgentMessage;
}

describe("compaction input curation", () => {
  it("leaves small tool results untouched without calling judgments", async () => {
    const evaluate = vi.fn();
    const messages = [toolResult("small output")];

    const result = await curateCompactionSummarizerInput(
      {
        messages,
        signal: new AbortController().signal,
      },
      evaluate,
    );

    expect(result.status).toBe("no-candidates");
    expect(result.messages).toBe(messages);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("keeps eligible content when the judgment is unavailable", async () => {
    const output = "x".repeat(3_000);
    const evaluate = vi.fn(async () => ({
      status: "unavailable",
      reason: "circuit-open",
    }) satisfies JudgmentOutcome);

    const result = await curateCompactionSummarizerInput(
      {
        messages: [toolResult(output)],
        signal: new AbortController().signal,
      },
      evaluate,
    );

    expect(result.status).toBe("unavailable");
    expect(result.omitted).toBe(0);
    expect(result.messages[0]).toMatchObject({
      role: "toolResult",
      content: [{ type: "text", text: output }],
    });
  });

  it("replaces only strongly redundant tool output in the temporary view", async () => {
    const output = "test log\n".repeat(400);
    const outcome: JudgmentOutcome = {
      status: "ok",
      result: {
        model: "fixture",
        answers: {
          "tool-result-1": {
            type: "choice",
            choice: "redundant",
            probabilities: {
              essential: 0.01,
              relevant: 0.02,
              redundant: 0.92,
              transient: 0.02,
              uncertain: 0.03,
            },
          },
        },
      },
      provenance: {
        providerId: "fixture",
        rubricVersion: "1",
        runtimeGeneration: "generation",
      },
    };
    const original = [toolResult(output), assistant("Three parser tests failed.")];

    const result = await curateCompactionSummarizerInput(
      {
        messages: original,
        unresolvedAsk: "Fix the parser tests.",
        signal: new AbortController().signal,
      },
      vi.fn(async () => outcome),
    );

    expect(result.status).toBe("ok");
    expect(result.omitted).toBe(1);
    expect(result.curatedChars).toBeLessThan(result.originalChars);
    expect(result.omittedEvidence).toEqual([
      {
        id: "tool-result-1",
        toolName: "exec",
        text: output,
      },
    ]);
    expect(result.messages).not.toBe(original);
    expect(result.messages[0]).toMatchObject({
      role: "toolResult",
      toolCallId: "call-1",
    });
    expect(JSON.stringify(result.messages[0])).toContain("omitted from compaction summarizer input");
    expect(JSON.stringify(original[0])).toContain(output.slice(0, 100));
  });

  it("keeps oversized tool results when the judgment cannot inspect the whole output", async () => {
    const output = `${"routine\n".repeat(1_200)}MATERIAL_RESULT_AT_TAIL`;
    const evaluate = vi.fn();
    const messages = [toolResult(output)];

    const result = await curateCompactionSummarizerInput(
      {
        messages,
        signal: new AbortController().signal,
      },
      evaluate,
    );

    expect(output.length).toBeGreaterThan(8_000);
    expect(result.status).toBe("no-candidates");
    expect(result.omitted).toBe(0);
    expect(result.messages).toBe(messages);
    expect(JSON.stringify(result.messages[0])).toContain("MATERIAL_RESULT_AT_TAIL");
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("keeps uncertain and low-probability results", async () => {
    const output = "x".repeat(3_000);
    const outcome: JudgmentOutcome = {
      status: "ok",
      result: {
        model: "fixture",
        answers: {
          "tool-result-1": {
            type: "choice",
            choice: "redundant",
            probabilities: {
              essential: 0.05,
              relevant: 0.05,
              redundant: 0.8,
              transient: 0.02,
              uncertain: 0.08,
            },
          },
        },
      },
      provenance: {
        providerId: "fixture",
        rubricVersion: "1",
        runtimeGeneration: "generation",
      },
    };
    const messages = [toolResult(output)];

    const result = await curateCompactionSummarizerInput(
      {
        messages,
        signal: new AbortController().signal,
      },
      vi.fn(async () => outcome),
    );

    expect(result.omitted).toBe(0);
    expect(result.messages).toBe(messages);
  });

  it("never considers error results for omission", async () => {
    const message = {
      ...toolResult("failure\n".repeat(400)),
      isError: true,
    } as AgentMessage;
    const evaluate = vi.fn();

    const result = await curateCompactionSummarizerInput(
      {
        messages: [message],
        signal: new AbortController().signal,
      },
      evaluate,
    );

    expect(result.status).toBe("no-candidates");
    expect(evaluate).not.toHaveBeenCalled();
  });
});
