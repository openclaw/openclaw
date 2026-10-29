// Featherless live tests prove text generation and a complete tool-call round trip.
import { completeSimple, type Model } from "openclaw/plugin-sdk/llm";
import { extractNonEmptyAssistantText, isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import {
  createLiveValueTool,
  createLiveToolReplayContext,
  requireLiveToolCall,
} from "../test-support/live-value-tool.test-support.js";
import { makeUserMessage } from "../test-support/message-fixtures.test-support.js";
import { buildFeatherlessProvider, FEATHERLESS_DEFAULT_MODEL_ID } from "./models.js";

const FEATHERLESS_API_KEY = process.env.FEATHERLESS_API_KEY?.trim() ?? "";
const LIVE = isLiveTestEnabled(["FEATHERLESS_LIVE_TEST"]) && FEATHERLESS_API_KEY.length > 0;
const describeLive = LIVE ? describe : describe.skip;

function resolveLiveModel(): Model<"openai-completions"> {
  const provider = buildFeatherlessProvider();
  const model = provider.models?.find((entry) => entry.id === FEATHERLESS_DEFAULT_MODEL_ID);
  if (!model) {
    throw new Error(`Featherless catalog does not include ${FEATHERLESS_DEFAULT_MODEL_ID}`);
  }
  return {
    provider: "featherless",
    baseUrl: provider.baseUrl,
    ...model,
    api: "openai-completions",
  } as Model<"openai-completions">;
}

describeLive("featherless plugin live", () => {
  it("completes a tool-call round trip with the default model", async () => {
    const model = resolveLiveModel();
    const tool = createLiveValueTool("live_echo");
    const userPrompt = makeUserMessage(
      "Call live_echo with value featherless. Do not answer directly.",
      Date.now() - 3,
    );
    const first = await completeSimple(
      model,
      {
        messages: [userPrompt],
        tools: [tool],
      },
      {
        apiKey: FEATHERLESS_API_KEY,
        maxTokens: 256,
      },
    );

    if (first.stopReason === "error") {
      throw new Error(first.errorMessage || "Featherless first turn returned an error");
    }
    const toolCall = requireLiveToolCall(first, "Featherless live model did not call a tool: ");
    expect(toolCall.name).toBe("live_echo");
    expect(toolCall.arguments).toEqual({ value: "featherless" });

    const second = await completeSimple(
      model,
      createLiveToolReplayContext(userPrompt, first, toolCall, tool),
      {
        apiKey: FEATHERLESS_API_KEY,
        maxTokens: 64,
      },
    );

    if (second.stopReason === "error") {
      throw new Error(second.errorMessage || "Featherless second turn returned an error");
    }
    expect(extractNonEmptyAssistantText(second.content)).toMatch(/^ok[.!]?$/i);
  }, 120_000);
});
