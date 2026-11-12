// Abliteration live tests prove text generation and a complete tool-call round trip.
import { completeSimple, type Model } from "openclaw/plugin-sdk/llm";
import { extractNonEmptyAssistantText, isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import {
  createLiveValueTool,
  createLiveToolReplayContext,
  requireLiveToolCall,
} from "../test-support/live-value-tool.test-support.js";
import { makeUserMessage } from "../test-support/message-fixtures.test-support.js";
import { ABLITERATION_DEFAULT_MODEL_REF, buildAbliterationProvider } from "./models.js";

const ABLITERATION_API_KEY = process.env.ABLITERATION_API_KEY?.trim() ?? "";
const LIVE = isLiveTestEnabled(["ABLITERATION_LIVE_TEST"]) && ABLITERATION_API_KEY.length > 0;
const describeLive = LIVE ? describe : describe.skip;

function resolveLiveModel(modelId?: string): Model<"openai-completions"> {
  const provider = buildAbliterationProvider();
  const model = provider.models?.find((entry) =>
    modelId ? entry.id === modelId : ABLITERATION_DEFAULT_MODEL_REF === `abliteration/${entry.id}`,
  );
  if (!model) {
    throw new Error(
      `Abliteration catalog does not include ${modelId ?? ABLITERATION_DEFAULT_MODEL_REF}`,
    );
  }
  return {
    provider: "abliteration",
    baseUrl: provider.baseUrl,
    ...model,
    api: "openai-completions",
  } as Model<"openai-completions">;
}

describeLive("abliteration plugin live", () => {
  it.each([
    { label: ABLITERATION_DEFAULT_MODEL_REF, modelId: undefined },
    { label: "abliterated-model-large-v2", modelId: "abliterated-model-large-v2" },
  ])(
    "completes a short text request with $label",
    async ({ modelId }) => {
      const response = await completeSimple(
        resolveLiveModel(modelId),
        { messages: [{ role: "user", content: "Reply with exactly: ok", timestamp: Date.now() }] },
        { apiKey: ABLITERATION_API_KEY, reasoning: "low", maxTokens: 2048 },
      );
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage || "Abliteration text request returned an error");
      }
      expect(extractNonEmptyAssistantText(response.content)).toMatch(/^ok[.!]?$/i);
    },
    120_000,
  );
  it("completes a tool-call round trip with the default model", async () => {
    const model = resolveLiveModel();
    const tool = createLiveValueTool("live_echo");
    const userPrompt = makeUserMessage(
      "Call live_echo with value abliteration. Do not answer directly.",
      Date.now() - 3,
    );
    const first = await completeSimple(
      model,
      {
        messages: [userPrompt],
        tools: [tool],
      },
      {
        apiKey: ABLITERATION_API_KEY,
        reasoning: "low",
        maxTokens: 2048,
      },
    );

    if (first.stopReason === "error") {
      throw new Error(first.errorMessage || "Abliteration first turn returned an error");
    }
    const toolCall = requireLiveToolCall(first, "Abliteration live model did not call a tool: ");
    expect(toolCall.name).toBe("live_echo");
    expect(toolCall.arguments).toEqual({ value: "abliteration" });

    const second = await completeSimple(
      model,
      createLiveToolReplayContext(userPrompt, first, toolCall, tool),
      {
        apiKey: ABLITERATION_API_KEY,
        reasoning: "low",
        maxTokens: 2048,
      },
    );

    if (second.stopReason === "error") {
      throw new Error(second.errorMessage || "Abliteration second turn returned an error");
    }
    expect(extractNonEmptyAssistantText(second.content)).toMatch(/^ok[.!]?$/i);
  }, 120_000);
});
