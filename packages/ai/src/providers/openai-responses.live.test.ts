import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Context, Model } from "../types.js";
import { streamOpenAIResponses } from "./openai-responses.js";

// Live coverage for the Responses stream state machine: real streams interleave
// reasoning/message/tool items, so unit fakes alone cannot prove slot tracking,
// terminal-event handling, or the max_output_tokens floor against the real API.
const LIVE = process.env.OPENCLAW_LIVE_TEST === "1";
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const describeLive = LIVE && OPENAI_KEY ? describe : describe.skip;

const LIVE_MODEL_ID = process.env.OPENCLAW_LIVE_RESPONSES_MODEL || "gpt-5.6-luna";
const LIVE_TIMEOUT_MS = 120_000;

function liveModel(overrides: Partial<Model<"openai-responses">> = {}) {
  return {
    id: LIVE_MODEL_ID,
    name: LIVE_MODEL_ID,
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
    ...overrides,
  } satisfies Model<"openai-responses">;
}

describeLive("OpenAI Responses live", () => {
  it(
    "streams a reply through a terminal event with usage accounting",
    async () => {
      const context: Context = {
        messages: [{ role: "user", content: "Reply with exactly: OK", timestamp: 0 }],
      };
      const result = await streamOpenAIResponses(liveModel(), context, {
        apiKey: OPENAI_KEY,
        maxTokens: 256,
      }).result();

      expect(result.errorMessage).toBeUndefined();
      expect(result.stopReason).toBe("stop");
      const text = result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      expect(text).toContain("OK");
      expect(result.usage.totalTokens).toBeGreaterThan(0);
      expect(result.usage.output).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "clamps a sub-floor max token budget instead of failing the request",
    async () => {
      const context: Context = {
        messages: [{ role: "user", content: "Reply with exactly: OK", timestamp: 0 }],
      };
      const result = await streamOpenAIResponses(liveModel(), context, {
        apiKey: OPENAI_KEY,
        maxTokens: 1,
      }).result();

      // Pre-floor behavior was a hard 400 from the API; truncation is expected.
      expect(result.errorMessage).toBeUndefined();
      expect(["stop", "length"]).toContain(result.stopReason);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "keeps reasoning and tool-call items separable on a real interleaved stream",
    async () => {
      const context: Context = {
        messages: [
          {
            role: "user",
            content: "Call the live_probe tool with value set to exactly LIVE_OK.",
            timestamp: 0,
          },
        ],
        tools: [
          {
            name: "live_probe",
            description: "Records a probe value.",
            parameters: Type.Object({ value: Type.String() }),
          },
        ],
      };
      const result = await streamOpenAIResponses(liveModel(), context, {
        apiKey: OPENAI_KEY,
        maxTokens: 1024,
        reasoningEffort: "low",
      }).result();

      expect(result.errorMessage).toBeUndefined();
      expect(result.stopReason).toBe("toolUse");
      const toolCalls = result.content.filter((block) => block.type === "toolCall");
      expect(toolCalls).toHaveLength(1);
      const probeCall = toolCalls[0];
      expect(probeCall?.name).toBe("live_probe");
      const probeArguments = (probeCall?.arguments ?? {}) as { value?: string };
      expect(probeArguments.value).toBe("LIVE_OK");
      for (const block of result.content) {
        if (block.type === "thinking") {
          expect(block.thinkingSignature).toBeTruthy();
        }
      }
    },
    LIVE_TIMEOUT_MS,
  );
});
