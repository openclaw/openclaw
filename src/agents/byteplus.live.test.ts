import { completeSimple, type Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../infra/env.js";
import { BYTEPLUS_CODING_BASE_URL, BYTEPLUS_DEFAULT_COST } from "./byteplus-models.js";

const BYTEPLUS_KEY = process.env.BYTEPLUS_API_KEY ?? "";
const BYTEPLUS_CODING_MODEL = process.env.BYTEPLUS_CODING_MODEL?.trim() || "ark-code-latest";
const LIVE = isTruthyEnvValue(process.env.BYTEPLUS_LIVE_TEST) || isTruthyEnvValue(process.env.LIVE);

const describeLive = LIVE && BYTEPLUS_KEY ? describe : describe.skip;

describeLive("byteplus coding plan live", () => {
  it("returns assistant text", async () => {
    const model: Model<"openai-completions"> = {
      id: BYTEPLUS_CODING_MODEL,
      name: `BytePlus Coding ${BYTEPLUS_CODING_MODEL}`,
      api: "openai-completions",
      provider: "byteplus-plan",
      baseUrl: BYTEPLUS_CODING_BASE_URL,
      reasoning: false,
      input: ["text"],
      cost: BYTEPLUS_DEFAULT_COST,
      contextWindow: 256000,
      maxTokens: 4096,
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
      { apiKey: BYTEPLUS_KEY, maxTokens: 64 },
    );

    const text = res.content
      .filter((block) => block.type === "text")
      .map((block) => block.text.trim())
      .join(" ");
    expect(text.length).toBeGreaterThan(0);
  }, 30000);
});
