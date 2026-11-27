// Nodecode live tests prove text generation and a complete tool-call round trip.
import { completeSimple, type Model } from "openclaw/plugin-sdk/llm";
import { extractNonEmptyAssistantText, isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import {
  createLiveValueTool,
  createLiveToolReplayContext,
  requireLiveToolCall,
} from "../test-support/live-value-tool.test-support.js";
import { makeUserMessage } from "../test-support/message-fixtures.test-support.js";
import { buildNodecodeProvider, NODECODE_DEFAULT_MODEL_REF } from "./models.js";

const NODECODE_API_KEY = process.env.NODECODE_API_KEY?.trim() ?? "";
const LIVE = isLiveTestEnabled(["NODECODE_LIVE_TEST"]) && NODECODE_API_KEY.length > 0;
const describeLive = LIVE ? describe : describe.skip;

function resolveLiveModel(): Model<"openai-completions"> {
  const provider = buildNodecodeProvider();
  const model = provider.models?.find(
    (entry) => NODECODE_DEFAULT_MODEL_REF === `nodecode/${entry.id}`,
  );
  if (!model) {
    throw new Error(`Nodecode catalog does not include ${NODECODE_DEFAULT_MODEL_REF}`);
  }
  return {
    provider: "nodecode",
    baseUrl: provider.baseUrl,
    ...model,
    api: "openai-completions",
  } as Model<"openai-completions">;
}

describeLive("nodecode plugin live", () => {
  it("completes a short text request with Cyber v1", async () => {
    const response = await completeSimple(
      resolveLiveModel(),
      { messages: [{ role: "user", content: "Reply with exactly: ok", timestamp: Date.now() }] },
      { apiKey: NODECODE_API_KEY, reasoning: "low", maxTokens: 2048 },
    );
    if (response.stopReason === "error") {
      throw new Error(response.errorMessage || "Nodecode text request returned an error");
    }
    expect(extractNonEmptyAssistantText(response.content)).toMatch(/^ok[.!]?$/i);
  }, 120_000);

  it("completes a tool-call round trip with Cyber v1", async () => {
    const model = resolveLiveModel();
    const tool = createLiveValueTool("live_echo");
    const userPrompt = makeUserMessage(
      "Call live_echo with value nodecode. Do not answer directly.",
      Date.now() - 3,
    );
    const first = await completeSimple(
      model,
      { messages: [userPrompt], tools: [tool] },
      { apiKey: NODECODE_API_KEY, reasoning: "low", maxTokens: 2048 },
    );
    if (first.stopReason === "error") {
      throw new Error(first.errorMessage || "Nodecode first turn returned an error");
    }
    const toolCall = requireLiveToolCall(first, "Nodecode live model did not call a tool: ");
    expect(toolCall.name).toBe("live_echo");
    expect(toolCall.arguments).toEqual({ value: "nodecode" });

    const second = await completeSimple(
      model,
      createLiveToolReplayContext(userPrompt, first, toolCall, tool),
      { apiKey: NODECODE_API_KEY, reasoning: "low", maxTokens: 2048 },
    );
    if (second.stopReason === "error") {
      throw new Error(second.errorMessage || "Nodecode second turn returned an error");
    }
    expect(extractNonEmptyAssistantText(second.content)).toMatch(/^ok[.!]?$/i);
  }, 120_000);
});
