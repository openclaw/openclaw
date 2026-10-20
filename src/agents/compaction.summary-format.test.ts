import type { CompactionSummaryPrompt, StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { summarizeCompactionHistory } from "./compaction.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

const model: Model = {
  id: "summary-model",
  name: "Summary Model",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 1_000,
};

function summarize(overrides: Partial<Parameters<typeof summarizeCompactionHistory>[0]>) {
  return summarizeCompactionHistory({
    messages: [{ role: "user", content: "Preserve the deployment decision.", timestamp: 1 }],
    model,
    apiKey: "test-key", // pragma: allowlist secret
    signal: new AbortController().signal,
    reserveTokens: 1_000,
    ...overrides,
  });
}

function response(overrides: Parameters<typeof makeAgentAssistantMessage>[0]) {
  const message = makeAgentAssistantMessage(overrides);
  const stream = createAssistantMessageEventStream();
  stream.push({
    type: "done",
    reason: overrides.stopReason === "length" ? "length" : "stop",
    message,
  });
  stream.end();
  return stream;
}

describe("compaction summary format propagation", () => {
  it("does not repeat an unchanged request after a reasoning-only length stop", async () => {
    const requests: Array<{ modelId: string; maxTokens: number | undefined }> = [];
    const streamFn: StreamFn = (selectedModel, _context, options) => {
      requests.push({ modelId: selectedModel.id, maxTokens: options?.maxTokens });
      return response({
        content: [{ type: "thinking", thinking: "reasoning filled the output budget" }],
        stopReason: "length",
      });
    };

    await expect(
      summarize({
        model: { ...model, reasoning: true },
        streamFn,
      }),
    ).rejects.toThrow("summary output budget (800 tokens) was exhausted");
    expect(requests).toEqual([{ modelId: model.id, maxTokens: 800 }]);
  });

  it.each([
    {
      kind: "custom",
      instructions: "Use exactly these headings:\n## Decisions\n## Pending user asks",
    },
    { kind: "turn-prefix" },
  ] satisfies CompactionSummaryPrompt[])(
    "retains $kind format and caller instructions in one summary request",
    async (summaryPrompt) => {
      const requests: string[] = [];
      const streamFn: StreamFn = (_model, context, options) => {
        requests.push(JSON.stringify(context));
        expect(options?.maxTokens).toBe(summaryPrompt.kind === "turn-prefix" ? 500 : 800);
        return response({ content: [{ type: "text", text: "summary" }] });
      };
      const result = await summarize({
        messages: Array.from({ length: 4 }, (_, index) => ({
          role: "user" as const,
          content: `receipt_${index}: ${"Keep the deployment decision. ".repeat(20)}`,
          timestamp: index + 1,
        })),
        summaryPrompt,
        customInstructions: "Preserve the canary decision.",
        streamFn,
      });
      expect(result).toBe("summary");
      expect(requests).toHaveLength(1);
      const [request] = requests;
      expect(request).toContain(
        summaryPrompt.kind === "turn-prefix" ? "## Original Request" : "## Pending user asks",
      );
      expect(request).not.toContain("## Goal");
      expect(request).not.toContain("UPDATE the Progress section");
      expect(request).toContain("Preserve the canary decision.");
      expect(request).toContain("Preserve all opaque identifiers exactly");
      expect(request).not.toContain("<previous-summary>");
    },
  );

  it("sends the previous summary with the caller format in the same request", async () => {
    const requests: string[] = [];
    const streamFn: StreamFn = (_model, context) => {
      requests.push(JSON.stringify(context));
      return response({ content: [{ type: "text", text: "retained summary" }] });
    };
    const result = await summarize({
      messages: [{ role: "user", content: "Keep receipt_90210", timestamp: 1 }],
      summaryPrompt: { kind: "custom", instructions: "Use ## Decisions and ## Pending user asks." },
      previousSummary: "Earlier canary decision.",
      streamFn,
    });
    expect(result).toBe("retained summary");
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request).toContain("## Pending user asks");
    expect(request).not.toContain("## Goal");
    expect(request).toContain("Keep receipt_90210");
    expect(request).toContain("<previous-summary>");
    expect(request).toContain("Earlier canary decision.");
  });
});
