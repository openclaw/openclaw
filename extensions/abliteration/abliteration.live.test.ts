// Abliteration live tests prove text generation and a complete tool-call round trip.
import {
  completeSimple,
  type AssistantMessage,
  type Model,
  type Tool,
} from "openclaw/plugin-sdk/llm";
import { extractNonEmptyAssistantText, isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { buildAbliterationProvider, ABLITERATION_DEFAULT_MODEL_ID } from "./models.js";

const ABLITERATION_API_KEY = process.env.ABLITERATION_API_KEY?.trim() ?? "";
const LIVE = isLiveTestEnabled(["ABLITERATION_LIVE_TEST"]) && ABLITERATION_API_KEY.length > 0;
const describeLive = LIVE ? describe : describe.skip;

function resolveLiveModel(modelId = ABLITERATION_DEFAULT_MODEL_ID): Model<"openai-completions"> {
  const provider = buildAbliterationProvider();
  const model = provider.models?.find((entry) => entry.id === modelId);
  if (!model) {
    throw new Error(`Abliteration catalog does not include ${modelId}`);
  }
  return {
    provider: "abliteration",
    baseUrl: provider.baseUrl,
    ...model,
    api: "openai-completions",
  } as Model<"openai-completions">;
}

function liveEchoTool(): Tool {
  return {
    name: "live_echo",
    description: "Return the supplied value.",
    parameters: Type.Object(
      {
        value: Type.String(),
      },
      { additionalProperties: false },
    ),
  };
}

function requireToolCall(message: AssistantMessage) {
  const toolCall = message.content.find((block) => block.type === "toolCall");
  if (toolCall?.type !== "toolCall") {
    throw new Error(`Abliteration live model did not call a tool: ${message.stopReason}`);
  }
  return toolCall;
}

describeLive("abliteration plugin live", () => {
  it.each([ABLITERATION_DEFAULT_MODEL_ID, "abliterated-model-large-v2"])(
    "completes a short text request with %s",
    async (modelId) => {
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
    const tool = liveEchoTool();
    const userPrompt = {
      role: "user" as const,
      content: "Call live_echo with value abliteration. Do not answer directly.",
      timestamp: Date.now() - 3,
    };
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
    const toolCall = requireToolCall(first);
    expect(toolCall.name).toBe("live_echo");
    expect(toolCall.arguments).toEqual({ value: "abliteration" });

    const second = await completeSimple(
      model,
      {
        messages: [
          userPrompt,
          first,
          {
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: [{ type: "text", text: "ok" }],
            isError: false,
            timestamp: Date.now() - 1,
          },
          {
            role: "user",
            content: "Reply with exactly: ok",
            timestamp: Date.now(),
          },
        ],
        tools: [tool],
      },
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
