import { completeSimple, type Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../infra/env.js";

const MOONSHOT_KEY = process.env.MOONSHOT_API_KEY ?? "";
const MOONSHOT_BASE_URL = process.env.MOONSHOT_BASE_URL?.trim() || "https://api.moonshot.ai/v1";
const MOONSHOT_MODEL = process.env.MOONSHOT_MODEL?.trim() || "kimi-k2.5";
const LIVE = isTruthyEnvValue(process.env.MOONSHOT_LIVE_TEST) || isTruthyEnvValue(process.env.LIVE);

const describeLive = LIVE && MOONSHOT_KEY ? describe : describe.skip;

describeLive("moonshot live", () => {
  it("returns assistant text", async () => {
    const model: Model<"openai-completions"> = {
      id: MOONSHOT_MODEL,
      name: `Moonshot ${MOONSHOT_MODEL}`,
      api: "openai-completions",
      provider: "moonshot",
      baseUrl: MOONSHOT_BASE_URL,
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 256000,
      maxTokens: 8192,
    };

    const res = await completeSimple(
      model,
      {
        messages: [
          {
            role: "user",
            content: "Reply with the word ok.",
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey: MOONSHOT_KEY, maxTokens: 64 },
    );

    const text = res.content
      .filter((block) => block.type === "text")
      .map((block) => block.text.trim())
      .join(" ");
    expect(text.length).toBeGreaterThan(0);
  }, 30000);
});
