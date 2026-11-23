// bf16.ai live tests prove text generation and a complete tool-call round trip.
import { completeSimple, type Model } from "openclaw/plugin-sdk/llm";
import { extractNonEmptyAssistantText, isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import {
  createLiveToolReplayContext,
  createLiveValueTool,
  requireLiveToolCall,
} from "../test-support/live-value-tool.test-support.js";
import { makeUserMessage } from "../test-support/message-fixtures.test-support.js";
import { BF16_DEFAULT_MODEL_REF, buildBf16Provider } from "./models.js";

const BF16_API_KEY = process.env.BF16_API_KEY?.trim() ?? "";
const LIVE = isLiveTestEnabled(["BF16_LIVE_TEST"]) && BF16_API_KEY.length > 0;
const describeLive = LIVE ? describe : describe.skip;

function resolveLiveModel(modelId?: string): Model<"openai-completions"> {
  const provider = buildBf16Provider();
  const model = provider.models?.find((entry) =>
    modelId ? entry.id === modelId : BF16_DEFAULT_MODEL_REF === `bf16/${entry.id}`,
  );
  if (!model) {
    throw new Error(`bf16.ai catalog does not include ${modelId ?? BF16_DEFAULT_MODEL_REF}`);
  }
  return {
    provider: "bf16",
    baseUrl: provider.baseUrl,
    ...model,
    api: "openai-completions",
  } as Model<"openai-completions">;
}

describeLive("bf16 plugin live", () => {
  it.each([
    { label: BF16_DEFAULT_MODEL_REF, modelId: undefined },
    { label: "zai-org/glm-5.3-flash-uncensored", modelId: "zai-org/glm-5.3-flash-uncensored" },
  ])(
    "completes a short text request with $label",
    async ({ modelId }) => {
      const response = await completeSimple(
        resolveLiveModel(modelId),
        { messages: [{ role: "user", content: "Reply with exactly: ok", timestamp: Date.now() }] },
        { apiKey: BF16_API_KEY, maxTokens: 2048 },
      );
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage || "bf16.ai text request returned an error");
      }
      expect(extractNonEmptyAssistantText(response.content)).toMatch(/^ok[.!]?$/i);
    },
    120_000,
  );

  it("completes a tool-call round trip with the default model", async () => {
    const model = resolveLiveModel();
    const tool = createLiveValueTool("live_echo");
    const userPrompt = makeUserMessage(
      "Call live_echo with value bf16. Do not answer directly.",
      Date.now() - 3,
    );
    const first = await completeSimple(
      model,
      {
        messages: [userPrompt],
        tools: [tool],
      },
      {
        apiKey: BF16_API_KEY,
        maxTokens: 2048,
      },
    );

    if (first.stopReason === "error") {
      throw new Error(first.errorMessage || "bf16.ai first turn returned an error");
    }
    const toolCall = requireLiveToolCall(first, "bf16.ai live model did not call a tool: ");
    expect(toolCall.name).toBe("live_echo");
    expect(toolCall.arguments).toEqual({ value: "bf16" });

    const second = await completeSimple(
      model,
      createLiveToolReplayContext(userPrompt, first, toolCall, tool),
      {
        apiKey: BF16_API_KEY,
        maxTokens: 2048,
      },
    );

    if (second.stopReason === "error") {
      throw new Error(second.errorMessage || "bf16.ai second turn returned an error");
    }
    expect(extractNonEmptyAssistantText(second.content)).toMatch(/^ok[.!]?$/i);
  }, 120_000);
});
