import type { Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { makeProviderModel } from "../providers/provider-model.test-support.js";
import {
  buildOpenAIResponsesCompactSystemMessage,
  buildOpenAIResponsesParams,
  sanitizeOpenAICodexResponsesParams,
} from "./openai-responses-params-internal.js";

const reasoningModel = makeProviderModel("openai-responses", "openai", "gpt-5.6-luna", {
  name: "GPT-5.6 Luna",
  baseUrl: "https://api.openai.com/v1",
  contextWindow: 256_000,
});

describe("sanitizeOpenAICodexResponsesParams", () => {
  it.each([
    "https://chatgpt.com/backend-api/codex",
    "https://chatgpt.com/backend-api/codex/responses",
  ])("restores stateless Codex payload policy after hooks at %s", (baseUrl) => {
    const codexModel = {
      ...reasoningModel,
      api: "openai-chatgpt-responses",
      baseUrl,
    } satisfies Model;
    const params = sanitizeOpenAICodexResponsesParams(codexModel, {
      model: codexModel.id,
      store: true,
      max_output_tokens: 128,
      metadata: { purpose: "dashboard-title" },
      text: { format: { type: "text" }, verbosity: "low" },
    });

    expect(params.store).toBe(false);
    expect(params).not.toHaveProperty("max_output_tokens");
    expect(params).not.toHaveProperty("metadata");
    expect(params.text).toEqual({ verbosity: "low" });
  });

  it("does not rewrite non-Codex Responses endpoints", () => {
    const params = sanitizeOpenAICodexResponsesParams(reasoningModel, {
      store: true,
      max_output_tokens: 128,
    });

    expect(params).toEqual({ store: true, max_output_tokens: 128 });
  });
});

describe("buildOpenAIResponsesCompactSystemMessage", () => {
  it("uses the developer role for reasoning models that support it", () => {
    expect(
      buildOpenAIResponsesCompactSystemMessage(reasoningModel, "Retain the conversation."),
    ).toEqual({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "Retain the conversation." }],
    });
  });

  it("falls back to the system role for xAI's native route, which disables the developer role", () => {
    const message = buildOpenAIResponsesCompactSystemMessage(
      { ...reasoningModel, provider: "xai", baseUrl: "https://api.x.ai/v1" },
      "Retain the conversation.",
    );
    expect(message.role).toBe("system");
  });

  it("uses the system role for non-reasoning models", () => {
    const message = buildOpenAIResponsesCompactSystemMessage(
      { ...reasoningModel, reasoning: false },
      "Retain the conversation.",
    );
    expect(message.role).toBe("system");
  });
});

describe("buildOpenAIResponsesParams reasoning summary", () => {
  it.each([
    [null, null],
    [undefined, "auto"],
  ] as const)("sends summary %s as %s", (reasoningSummary, expected) => {
    const params = buildOpenAIResponsesParams(
      reasoningModel,
      { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      { reasoningEffort: "medium", reasoningSummary },
    );

    expect(params.reasoning).toEqual({ effort: "medium", summary: expected });
    expect(params.include).toEqual(["reasoning.encrypted_content"]);
  });
});
