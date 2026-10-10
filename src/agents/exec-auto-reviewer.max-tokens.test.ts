import { describe, expect, it, vi } from "vitest";
import type { Model } from "../llm/types.js";
import { createModelExecAutoReviewer, type ExecReviewerConfig } from "./exec-auto-reviewer.js";
import {
  acquireSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel,
} from "./simple-completion-runtime.js";

// mock-isolation: keep model acquisition and provider I/O outside this completion-budget unit test.
vi.mock("./simple-completion-runtime.js", () => ({
  acquireSimpleCompletionModelForAgent: vi.fn(),
  completeWithPreparedSimpleCompletionModel: vi.fn(),
}));

const input = {
  command: "git status",
  host: "gateway" as const,
  reason: "approval-required" as const,
  analysis: { parsed: true, allowlistMatched: false, inlineEval: false },
};
const model: Model = {
  provider: "ollama",
  id: "reviewer",
  name: "Reviewer",
  api: "ollama",
  baseUrl: "http://localhost:11434",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_768,
  maxTokens: 8_192,
};

async function review(params: {
  reasoning: boolean;
  maxTokens: number;
  thinking?: ExecReviewerConfig["thinking"];
}) {
  vi.mocked(acquireSimpleCompletionModelForAgent).mockResolvedValue({
    selection: { provider: model.provider, modelId: model.id, agentDir: "/agent" },
    model: { ...model, reasoning: params.reasoning, maxTokens: params.maxTokens },
    auth: { mode: "api-key", source: "local" },
    [Symbol.asyncDispose]: async () => {},
  });
  const complete = vi.mocked(completeWithPreparedSimpleCompletionModel);
  complete.mockReset();
  complete.mockImplementation(async ({ options }) => {
    // A reasoning response can consume the old limit before producing any verdict text.
    const exhausted = params.reasoning && (options?.maxTokens ?? 0) <= 1_024;
    return {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: 0,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: exhausted ? "length" : "stop",
      content: exhausted
        ? []
        : [{ type: "text", text: '{"decision":"allow","risk":"low","rationale":"read-only"}' }],
    };
  });
  const reviewer = createModelExecAutoReviewer({
    cfg: {},
    reviewer: { thinking: params.thinking },
  });
  return { decision: await reviewer(input), complete };
}

describe("exec auto-reviewer automatic completion budget", () => {
  it.each<{ thinking?: ExecReviewerConfig["thinking"]; maxTokens: number; expected: number }>([
    { thinking: "minimal", maxTokens: 32_768, expected: 2_048 },
    { thinking: "low", maxTokens: 8_192, expected: 3_072 },
    { thinking: "medium", maxTokens: 32_768, expected: 9_216 },
    { thinking: "high", maxTokens: 32_768, expected: 17_408 },
    { thinking: "xhigh", maxTokens: 32_768, expected: 17_408 },
    { thinking: "max", maxTokens: 65_536, expected: 33_792 },
    { maxTokens: 8_192, expected: 8_192 },
    { thinking: "low", maxTokens: 1_500.5, expected: 1_500 },
    { thinking: "low", maxTokens: Number.NaN, expected: 3_072 },
  ])("completes a verdict with $thinking thinking and model cap $maxTokens", async (params) => {
    const { decision, complete } = await review({ ...params, reasoning: true });
    expect(decision).toMatchObject({ decision: "allow-once", risk: "low" });
    expect(complete.mock.calls[0]?.[0].options?.maxTokens).toBe(params.expected);
  });

  it.each([500, 8_192, Number.NaN])(
    "preserves non-reasoning budget with model cap %s",
    async (maxTokens) => {
      const { decision, complete } = await review({
        reasoning: false,
        thinking: "high",
        maxTokens,
      });
      expect(decision).toMatchObject({ decision: "allow-once" });
      expect(complete.mock.calls[0]?.[0].options?.maxTokens).toBe(maxTokens === 500 ? 500 : 1_024);
    },
  );

  it("defers to human approval when the model cap cannot fit thinking and a verdict", async () => {
    const { decision, complete } = await review({
      reasoning: true,
      thinking: "low",
      maxTokens: 500,
    });
    expect(decision).toMatchObject({
      decision: "ask",
      rationale: expect.stringContaining("length"),
    });
    expect(complete.mock.calls[0]?.[0].options?.maxTokens).toBe(500);
  });
});
