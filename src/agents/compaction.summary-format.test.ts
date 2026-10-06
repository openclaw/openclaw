import type { CompactionSummaryPrompt, StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { summarizeInStages } from "./compaction.js";
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
  contextWindow: 2_000,
  maxTokens: 1_000,
};

describe("compaction summary format propagation", () => {
  it("does not repeat an unchanged request after a reasoning-only length stop", async () => {
    const requests: Array<{ modelId: string; maxTokens: number | undefined }> = [];
    const streamFn: StreamFn = (selectedModel, _context, options) => {
      requests.push({ modelId: selectedModel.id, maxTokens: options?.maxTokens });
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: "length",
        message: makeAgentAssistantMessage({
          content: [{ type: "thinking", thinking: "reasoning filled the output budget" }],
          stopReason: "length",
        }),
      });
      stream.end();
      return stream;
    };

    await expect(
      summarizeInStages({
        messages: [{ role: "user", content: "Preserve the deployment decision.", timestamp: 1 }],
        model: { ...model, reasoning: true },
        apiKey: "test-key", // pragma: allowlist secret
        signal: new AbortController().signal,
        reserveTokens: 1_000,
        maxChunkTokens: 1_000,
        contextWindow: 2_000,
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
    "retains $kind format through chunk updates and stage merge",
    async (summaryPrompt) => {
      const requests: string[] = [];
      const streamFn: StreamFn = (_model, context, options) => {
        requests.push(JSON.stringify(context));
        expect(options?.maxTokens).toBe(summaryPrompt.kind === "turn-prefix" ? 500 : 800);
        const stream = createAssistantMessageEventStream();
        stream.push({
          type: "done",
          reason: "stop",
          message: makeAgentAssistantMessage({
            content: [{ type: "text", text: `summary-${requests.length}` }],
          }),
        });
        stream.end();
        return stream;
      };
      const result = await summarizeInStages({
        messages: Array.from({ length: 4 }, (_, index) => ({
          role: "user" as const,
          content: `receipt_${index}: ${"Keep the deployment decision. ".repeat(20)}`,
          timestamp: index + 1,
        })),
        model,
        apiKey: "test-key",
        signal: new AbortController().signal,
        reserveTokens: 1_000,
        maxChunkTokens: 200,
        contextWindow: 2_000,
        summaryPrompt,
        customInstructions: "Preserve the canary decision.",
        streamFn,
      });
      expect(result).toBe(`summary-${requests.length}`);
      expect(requests.some((request) => request.includes("<previous-summary>"))).toBe(true);
      expect(requests.at(-1)).toContain("Merge these partial summaries");
      for (const request of requests) {
        expect(request).toContain(
          summaryPrompt.kind === "turn-prefix" ? "## Original Request" : "## Pending user asks",
        );
        expect(request).not.toContain("## Goal");
        expect(request).not.toContain("UPDATE the Progress section");
        expect(request).toContain("Preserve the canary decision.");
        expect(request).toContain("Preserve all opaque identifiers exactly");
      }
    },
  );

  it("retains caller format and previous summary when oversized history needs fallback", async () => {
    const requests: string[] = [];
    const streamFn: StreamFn = (_model, context) => {
      requests.push(JSON.stringify(context));
      if (requests.length === 1) {
        throw new Error("request timed out");
      }
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: "stop",
        message: makeAgentAssistantMessage({
          content: [{ type: "text", text: "retained summary" }],
        }),
      });
      stream.end();
      return stream;
    };
    const result = await summarizeInStages({
      messages: [
        { role: "user", content: "x".repeat(6_000), timestamp: 1 },
        { role: "user", content: "Keep receipt_90210", timestamp: 2 },
      ],
      model,
      apiKey: "test-key",
      signal: new AbortController().signal,
      reserveTokens: 1_000,
      maxChunkTokens: 10_000,
      contextWindow: 2_000,
      parts: 1,
      summaryPrompt: { kind: "custom", instructions: "Use ## Decisions and ## Pending user asks." },
      previousSummary: "Earlier canary decision.",
      streamFn,
    });
    expect(result).toContain("retained summary");
    expect(requests).toHaveLength(2);
    expect(requests[1]).not.toContain("x".repeat(6_000));
    expect(requests[1]).toContain("Keep receipt_90210");
    for (const request of requests) {
      expect(request).toContain("## Pending user asks");
      expect(request).not.toContain("## Goal");
      expect(request).toContain("Earlier canary decision.");
      expect(request).toContain("<previous-summary>");
    }
  });
});
