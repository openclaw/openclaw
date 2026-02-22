import { completeSimple, type Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../infra/env.js";
import { normalizeModelCompat } from "./model-compat.js";

const DASHSCOPE_KEY = process.env.OPENAI_API_KEY ?? "";
const LIVE =
  isTruthyEnvValue(process.env.DASHSCOPE_LIVE_TEST) || isTruthyEnvValue(process.env.LIVE);

const describeLive = LIVE && DASHSCOPE_KEY ? describe : describe.skip;

describeLive("dashscope developer role guard live (#22710)", () => {
  const baseModel = (): Model<"openai-completions"> => ({
    id: process.env.TEXT_MODEL ?? "qwen3.5-plus",
    name: "Qwen3.5 Plus",
    api: "openai-completions",
    provider: "dashscope",
    baseUrl: process.env.OPENAI_API_BASE ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 4096,
  });

  it("succeeds with normalizeModelCompat (system role)", async () => {
    const model = normalizeModelCompat(baseModel());

    // compat should be set by normalizeModelCompat
    expect(
      (model.compat as { supportsDeveloperRole?: boolean } | undefined)?.supportsDeveloperRole,
    ).toBe(false);

    const res = await completeSimple(
      model,
      {
        systemPrompt: "You are a helpful assistant. Reply concisely.",
        messages: [{ role: "user", content: "Reply with the word ok.", timestamp: Date.now() }],
      },
      { apiKey: DASHSCOPE_KEY, maxTokens: 64 },
    );

    const text = res.content
      .filter((block) => block.type === "text")
      .map((block) => block.text.trim())
      .join(" ");
    expect(text.length).toBeGreaterThan(0);
    console.log("✅ PASS: DashScope reasoning model with system role succeeded:", text);
  }, 30000);

  it("sends developer role WITHOUT normalizeModelCompat and gets error", async () => {
    const model = baseModel();
    // Force developer role by explicitly setting supportsDeveloperRole: true
    model.compat = { supportsDeveloperRole: true };

    const res = await completeSimple(
      model,
      {
        systemPrompt: "You are a helpful assistant.",
        messages: [{ role: "user", content: "Reply with the word ok.", timestamp: Date.now() }],
      },
      { apiKey: DASHSCOPE_KEY, maxTokens: 64 },
    );

    // pi-ai catches the 400 error and returns it in the result object
    // instead of throwing — so we check stopReason and errorMessage
    expect(res.stopReason).toBe("error");
    expect(res.errorMessage).toBeDefined();
    expect(res.errorMessage).toContain("developer");
    console.log(
      "✅ PASS: DashScope rejects developer role (error in result):",
      res.errorMessage?.slice(0, 200),
    );
  }, 30000);
});
