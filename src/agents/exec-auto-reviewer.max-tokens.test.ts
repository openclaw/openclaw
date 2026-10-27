import { expect, it, vi } from "vitest";
import { createModelExecAutoReviewer, type ExecReviewerConfig } from "./exec-auto-reviewer.js";
import {
  acquireSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel,
} from "./simple-completion-runtime.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

type Thinking = ExecReviewerConfig["thinking"];

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
const model = makeProviderModelFixture({
  provider: "ollama",
  id: "reviewer",
  api: "ollama",
  baseUrl: "http://localhost:11434",
});

async function review(maxTokens: number, thinking?: Thinking, reasoning = true) {
  vi.mocked(acquireSimpleCompletionModelForAgent).mockResolvedValue({
    selection: { provider: model.provider, modelId: model.id, agentDir: "/agent" },
    model: { ...model, reasoning, maxTokens },
    auth: { mode: "api-key", source: "local" },
    [Symbol.asyncDispose]: async () => {},
  });
  const complete = vi.mocked(completeWithPreparedSimpleCompletionModel);
  complete.mockReset();
  complete.mockImplementation(async ({ options }) => {
    // A reasoning response can consume the old limit before producing any verdict text.
    const exhausted = reasoning && (options?.maxTokens ?? 0) <= 1_024;
    return makeAgentAssistantMessage({
      stopReason: exhausted ? "length" : "stop",
      content: exhausted
        ? []
        : [{ type: "text", text: '{"decision":"allow","risk":"low","rationale":"read-only"}' }],
    });
  });
  const decision = await createModelExecAutoReviewer({ cfg: {}, reviewer: { thinking } })(input);
  return { decision, budget: complete.mock.calls[0]?.[0].options?.maxTokens };
}

it.each<{ thinking?: Thinking; maxTokens: number; expected: number }>([
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
  const { decision, budget } = await review(params.maxTokens, params.thinking);
  expect(decision).toMatchObject({ decision: "allow-once", risk: "low" });
  expect(budget).toBe(params.expected);
});

it.each([500, 8_192, Number.NaN])(
  "preserves non-reasoning budget with model cap %s",
  async (maxTokens) => {
    const { decision, budget } = await review(maxTokens, "high", false);
    expect(decision).toMatchObject({ decision: "allow-once" });
    expect(budget).toBe(maxTokens === 500 ? 500 : 1_024);
  },
);

it("defers to human approval when the model cap cannot fit thinking and a verdict", async () => {
  const { decision, budget } = await review(500, "low");
  expect(decision).toMatchObject({
    decision: "ask",
    rationale: expect.stringContaining("length"),
  });
  expect(budget).toBe(500);
});
