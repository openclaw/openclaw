import { describe, expect, it } from "vitest";
import type { Context, Model } from "../types.js";
import { streamSimpleAnthropic } from "./anthropic.js";

const apiKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
const live = process.env.OPENCLAW_LIVE_TEST === "1" && apiKey.length > 0;
const describeLive = live ? describe : describe.skip;
const timeoutMs = 120_000;

const model: Model<"anthropic-messages"> = {
  id: "claude-haiku-4-5",
  name: "Claude Haiku 4.5",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  contextWindow: 200_000,
  maxTokens: 8_192,
};

describeLive("Anthropic provider live", () => {
  it(
    "streams a basic response with usage",
    async () => {
      const result = await streamSimpleAnthropic(
        model,
        { messages: [{ role: "user", content: "Reply with the single word ok.", timestamp: 0 }] },
        { apiKey, maxTokens: 32, reasoning: "off" },
      ).result();

      expect(result.stopReason).toBe("stop");
      expect(result.usage.output).toBeGreaterThan(0);
    },
    timeoutMs,
  );

  it(
    "parses long-retention cache-write usage",
    async () => {
      const context: Context = {
        systemPrompt: "Stable cacheable provider context. ".repeat(2_000),
        messages: [{ role: "user", content: "Reply briefly with ok.", timestamp: 0 }],
      };
      const result = await streamSimpleAnthropic(model, context, {
        apiKey,
        cacheRetention: "long",
        maxTokens: 32,
        reasoning: "off",
      }).result();

      expect(result.stopReason).toBe("stop");
      expect(result.usage.cacheWrite).toBeGreaterThanOrEqual(0);
      if (result.usage.cacheWrite1h !== undefined) {
        expect(result.usage.cacheWrite1h).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(result.usage.cost.cacheWrite)).toBe(true);
      }
    },
    timeoutMs,
  );

  it(
    "keeps the signature on a streamed thinking block",
    async () => {
      const result = await streamSimpleAnthropic(
        model,
        {
          messages: [
            {
              role: "user",
              content: "Think through whether 17 is prime, then answer in one sentence.",
              timestamp: 0,
            },
          ],
        },
        { apiKey, maxTokens: 128, reasoning: "low" },
      ).result();

      expect(result.stopReason).toBe("stop");
      const thinking = result.content.find((block) => block.type === "thinking");
      expect(thinking?.thinkingSignature?.length).toBeGreaterThan(0);
    },
    timeoutMs,
  );
});
