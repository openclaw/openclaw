import { createOpenAICompletionsTransportStreamFn } from "@openclaw/ai/transports";
import { streamSimple, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { extractNonEmptyAssistantText, isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import zaiPlugin from "./index.js";

const ZAI_API_KEY = process.env.ZAI_API_KEY?.trim() ?? "";
const LIVE = isLiveTestEnabled(["ZAI_LIVE_TEST"]) && ZAI_API_KEY.length > 0;
const describeLive = LIVE ? describe : describe.skip;
const MODEL_ID = "glm-5.3-flash";
// The Coding Plan endpoint accepts disabled thinking and would hide this regression.
const BASE_URL = "https://api.z.ai/api/paas/v4";
const MAX_TOKENS = 256;

describeLive("Z.AI plugin live thinking off", () => {
  it.each([
    { path: "simple completion", hook: "wrapSimpleCompletionStreamFn", streamFn: streamSimple },
    {
      path: "agent turn",
      hook: "wrapStreamFn",
      streamFn: createOpenAICompletionsTransportStreamFn(),
    },
  ] as const)(
    "completes $path on the general endpoint with low effort",
    async ({ hook, streamFn }) => {
      const provider = await registerSingleProviderPlugin(zaiPlugin);
      const model: Model<"openai-completions"> = {
        id: MODEL_ID,
        name: "GLM-5.3-Flash",
        provider: "zai",
        api: "openai-completions",
        baseUrl: BASE_URL,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_048_576,
        maxTokens: MAX_TOKENS,
      };
      // Missing optional hooks use the underlying transport, as in production.
      const wrapped =
        provider[hook]?.({
          provider: "zai",
          modelId: model.id,
          model,
          sourceApi: model.api,
          ...(hook === "wrapStreamFn" ? { thinkingLevel: "off" } : {}),
          streamFn,
        }) ?? streamFn;
      let payload: Record<string, unknown> | undefined;
      const stream = await wrapped(
        model,
        {
          messages: [
            { role: "user", content: "Reply with the single word OK.", timestamp: Date.now() },
          ],
        },
        {
          apiKey: ZAI_API_KEY,
          reasoning: "off",
          maxTokens: MAX_TOKENS,
          signal: AbortSignal.timeout(40_000),
          onPayload: (value) => {
            payload = value as Record<string, unknown>;
          },
        },
      );
      const response = await stream.result();
      expect(response.stopReason, response.errorMessage).not.toBe("error");
      expect(extractNonEmptyAssistantText(response.content).trim()).not.toBe("");
      expect(payload).toMatchObject({
        model: MODEL_ID,
        max_tokens: MAX_TOKENS,
        reasoning_effort: "low",
      });
      expect(payload).not.toHaveProperty("thinking");
      expect(payload).not.toHaveProperty("enable_thinking");
    },
    45_000,
  );
});
