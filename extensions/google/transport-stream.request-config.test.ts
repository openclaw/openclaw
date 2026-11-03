import type { Model } from "openclaw/plugin-sdk/llm";
import { expect, it } from "vitest";
import { buildGoogleGenerativeAiParams } from "./transport-stream.js";

it("keeps sampling options request-local on the stable GenerateContent owner", () => {
  const model: Model<"google-generative-ai"> = {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
  const context = { messages: [] };
  const first = buildGoogleGenerativeAiParams(model, context, {
    maxTokens: 64,
    temperature: 0.25,
    topP: 0.4,
    stop: ["END"],
  });
  const second = buildGoogleGenerativeAiParams(model, context, { maxTokens: 128 });

  expect(first.generationConfig).not.toBe(second.generationConfig);
  expect(first.generationConfig).toEqual({
    maxOutputTokens: 64,
    temperature: 0.25,
    topP: 0.4,
    stopSequences: ["END"],
  });
  expect(second.generationConfig).toEqual({ maxOutputTokens: 128 });
});
