import { completeSimple, type Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  createSingleUserPromptMessage,
  extractNonEmptyAssistantText,
  isLiveTestEnabled,
} from "./live-test-helpers.js";
import { LEMONADE_DEFAULT_BASE_URL, LEMONADE_MODEL_PLACEHOLDER } from "./lemonade-defaults.js";

const LEMONADE_KEY = process.env.LEMONADE_API_KEY?.trim() || "lemonade-local";
const LEMONADE_BASE_URL = process.env.LEMONADE_BASE_URL?.trim() || LEMONADE_DEFAULT_BASE_URL;
const LEMONADE_MODEL = process.env.LEMONADE_MODEL?.trim() || LEMONADE_MODEL_PLACEHOLDER;
const LIVE = isLiveTestEnabled(["LEMONADE_LIVE_TEST"]);

const describeLive = LIVE ? describe : describe.skip;

describeLive("lemonade live", () => {
  it("returns assistant text", async () => {
    const model: Model<"openai-completions"> = {
      id: LEMONADE_MODEL,
      name: `Lemonade ${LEMONADE_MODEL}`,
      api: "openai-completions",
      provider: "lemonade",
      baseUrl: LEMONADE_BASE_URL,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 2048,
    };

    const res = await completeSimple(
      model,
      { messages: createSingleUserPromptMessage() },
      { apiKey: LEMONADE_KEY, maxTokens: 64 },
    );

    const text = extractNonEmptyAssistantText(res.content);
    expect(text.length).toBeGreaterThan(0);
  }, 30000);
});
