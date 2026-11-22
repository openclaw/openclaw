import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { afterEach, describe, expect, it } from "vitest";
import { makeProviderModel } from "../providers/provider-model.test-support.js";
import { cleanupSessionResources } from "../session-resources.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import { captureOpenAIResponses } from "./openai-responses-live-capture.test-support.js";

const LIVE = process.env.OPENCLAW_LIVE_TEST === "1";
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const describeLive = LIVE && OPENAI_KEY ? describe : describe.skip;

// Padding keeps the prompt above the provider's minimum cacheable prefix.
const padding = Array.from({ length: 300 }, (_, index) => `Reference note ${index}: none.`).join(
  "\n",
);
const promptA = `You are a terse test assistant. End every reply with the token ALPHA-1.\n${padding}`;
const promptB = `You are a terse test assistant. End every reply with the token BRAVO-2.\n${padding}`;

type WireItem = { role?: string; content?: Array<{ text?: string }> };
const developerTexts = (request: Record<string, unknown> | undefined) =>
  ((request?.input ?? []) as WireItem[])
    .filter((item) => item.role === "developer")
    .map((item) => item.content?.map((part) => part.text).join(""));
const replyText = (message: AssistantMessage) =>
  message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");

describeLive("uncached instructions on the real native OpenAI Responses API", () => {
  afterEach(() => cleanupSessionResources());

  it.each(["gpt-6.2-astra", "gpt-6.2-sol"])(
    "%s reuses cached instructions and replays when the system prompt changes",
    async (modelId) => {
      const model: Model<"openai-responses"> = makeProviderModel(
        "openai-responses",
        "openai",
        modelId,
        {
          baseUrl: "https://api.openai.com/v1",
          contextWindow: 272_000,
          reasoning: true,
          compat: { cachesInstructions: false },
        },
      );
      const messages: Context["messages"] = [];
      const turn = async (systemPrompt: string, text: string) => {
        messages.push({ role: "user", content: text, timestamp: messages.length + 1 });
        const { result, requests } = await captureOpenAIResponses(async () => {
          const stream = await createOpenAIResponsesTransportStreamFn()(
            model,
            { systemPrompt, messages: [...messages], tools: [] },
            {
              apiKey: OPENAI_KEY,
              sessionId: "live-uncached-instructions",
              transport: "sse",
              reasoningEffort: "low",
              maxTokens: 256,
              onPayload: (payload: Record<string, unknown>) => ({ ...payload, store: true }),
            } as never,
          );
          return stream.result();
        });
        expect(result.stopReason).toBe("stop");
        messages.push(result);
        console.log(
          JSON.stringify({
            previous_response_id: Boolean(requests[0]?.previous_response_id),
            instructions: requests[0]?.instructions !== undefined,
            inputItems: (requests[0]?.input as unknown[] | undefined)?.length,
            developer: developerTexts(requests[0]).map((value) => value?.slice(0, 70)),
            usage: { input: result.usage.input, cacheRead: result.usage.cacheRead },
            reply: replyText(result),
          }),
        );
        return {
          request: requests[0],
          reply: replyText(result),
          cacheRead: result.usage.cacheRead,
        };
      };

      const first = await turn(promptA, "Say hi.");
      expect(first.request).not.toHaveProperty("instructions");
      expect(developerTexts(first.request)).toEqual([promptA]);
      expect(first.reply).toContain("ALPHA-1");

      const delta = await turn(promptA, "Name one prime number.");
      expect(delta.request?.previous_response_id).toEqual(expect.any(String));
      expect(developerTexts(delta.request)).toEqual([]);
      expect(delta.reply).toContain("ALPHA-1");
      // Only the fixed system prompt is long enough to account for this many cache reads.
      expect(delta.cacheRead, "warm Responses cache reads").toBeGreaterThanOrEqual(1_024);

      const changed = await turn(promptB, "Name one even number.");
      expect(changed.request).not.toHaveProperty("previous_response_id");
      expect(developerTexts(changed.request)).toEqual([promptB]);
      expect(changed.reply).toContain("BRAVO-2");
      expect(changed.reply).not.toContain("ALPHA-1");
    },
    180_000,
  );
});
