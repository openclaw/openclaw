import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isolatedAssistant,
  isolatedCompletionMocks as mocks,
  isolatedRequest,
  nativeAuthPlan,
  registerIsolatedHarness,
  resetIsolatedCompletionTestState,
  runIsolatedCompletion,
} from "./isolated-completion.test-support.js";

beforeEach(resetIsolatedCompletionTestState);

describe("isolated completion token budgets", () => {
  it.each(["host-v1", "host-v2", "harness-v2", "cli"] as const)(
    "reserves utility reasoning while preserving explicit limits through %s",
    async (route) => {
      const model = {
        provider: "openai",
        id: "gpt-test",
        api: "openai-chatgpt-responses",
        baseUrl: nativeAuthPlan.modelRoute.baseUrl,
        reasoning: true,
        maxTokens: 16_384,
      };
      mocks.resolveModelAsync.mockResolvedValue({ model });
      mocks.prepareSimpleCompletionModel.mockResolvedValue({
        model,
        auth: { apiKey: "synthetic-key", mode: "api-key", source: "test" },
      });
      const dispatch = vi.fn(async () => ({
        assistant: isolatedAssistant([{ type: "text", text: "done" }]),
      }));
      mocks.isCliRuntimeAliasForProvider.mockReturnValue(route === "cli");
      mocks.runCliAgent.mockResolvedValue({ payloads: [{ text: "done" }] });
      registerIsolatedHarness({
        authBootstrap: route === "harness-v2" ? "harness" : undefined,
        ...(route === "host-v1"
          ? { runIsolatedCompletion: dispatch }
          : { runIsolatedCompletionV2: dispatch }),
      });
      for (const budget of [
        { answerTokenBudget: 300, streamParams: { temperature: 0.2 } },
        { streamParams: { maxTokens: 100, temperature: 0.2 } },
        { answerTokenBudget: 300, streamParams: { maxTokens: 150, temperature: 0.2 } },
        {},
      ]) {
        await runIsolatedCompletion({ ...isolatedRequest(), ...budget });
      }
      const completion = route === "cli" ? mocks.runCliAgent : dispatch;
      for (const [index, maxTokens] of [route === "cli" ? 300 : 8_492, 100, 150].entries()) {
        expect(completion).toHaveBeenNthCalledWith(
          index + 1,
          expect.objectContaining({ streamParams: { maxTokens, temperature: 0.2 } }),
        );
      }
      expect(completion).toHaveBeenNthCalledWith(
        4,
        expect.objectContaining({ streamParams: undefined }),
      );
    },
  );

  it.each([
    { reasoning: true, modelMaxTokens: 1_024, expected: 1_024 },
    { reasoning: false, modelMaxTokens: 16_384, expected: 300 },
    { reasoning: false, modelMaxTokens: 128, expected: 128 },
  ])("fits the answer budget to model capabilities: %j", async (capability) => {
    mocks.prepareSimpleCompletionModel.mockResolvedValue({
      model: {
        provider: "openai",
        id: "gpt-test",
        api: "openai-responses",
        reasoning: capability.reasoning,
        maxTokens: capability.modelMaxTokens,
      },
      auth: { apiKey: "synthetic-key", mode: "api-key", source: "test" },
    });
    const dispatch = vi.fn(async () => ({
      assistant: isolatedAssistant([{ type: "text", text: "done" }]),
    }));
    registerIsolatedHarness({ runIsolatedCompletionV2: dispatch });
    await runIsolatedCompletion({ ...isolatedRequest(), answerTokenBudget: 300 });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ streamParams: { maxTokens: capability.expected } }),
    );
  });
});
