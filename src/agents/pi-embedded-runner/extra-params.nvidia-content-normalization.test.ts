import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { runExtraParamsCase } from "./extra-params.test-support.js";
import { createOpenAICompatContentNormalizationWrapper } from "./openai-stream-wrappers.js";

/**
 * Tests for the OpenAI-compatible content normalization wrapper.
 *
 * NVIDIA (and other third-party OpenAI-compatible providers like vLLM, Ollama,
 * LiteLLM) reject the Anthropic-style `[{type:"text", text:"..."}]` content
 * format that pi-ai emits for user messages. The normalization wrapper
 * flattens text-only content arrays to plain strings in the outbound payload.
 *
 * Regression test for openclaw/openclaw#50107.
 */

type MessagePayload = Record<string, unknown> & {
  messages: Array<{ role: string; content: unknown }>;
};

function buildPayload(messages: Array<{ role: string; content: unknown }>): MessagePayload {
  return { messages } as MessagePayload;
}

function capturePayload(params: {
  provider: string;
  modelId: string;
  baseUrl: string;
  messages: Array<{ role: string; content: unknown }>;
}) {
  const payload = buildPayload(params.messages);
  runExtraParamsCase({
    applyModelId: params.modelId,
    applyProvider: params.provider,
    model: {
      api: "openai-completions",
      provider: params.provider,
      id: params.modelId,
      baseUrl: params.baseUrl,
    } as Model<"openai-completions">,
    payload,
  });
  return payload;
}

/**
 * Invoke the wrapper directly with a given model and payload.
 * This avoids going through `applyExtraParamsToAgent` (which can trigger
 * slow plugin discovery for certain provider names in the test environment).
 */
function captureWrapperDirect(params: {
  api: string;
  provider: string;
  modelId: string;
  messages: Array<{ role: string; content: unknown }>;
}) {
  const payload = buildPayload(params.messages);
  const capturedPayload: Record<string, unknown>[] = [];

  const baseStreamFn: StreamFn = (_model, _context, options) => {
    options?.onPayload?.(payload, _model);
    capturedPayload.push(payload);
    return createAssistantMessageEventStream();
  };

  const wrapped = createOpenAICompatContentNormalizationWrapper(baseStreamFn);
  const model = {
    api: params.api,
    provider: params.provider,
    id: params.modelId,
  } as Model<"openai-completions">;
  const context: Context = { messages: [] };

  void wrapped(model, context, {});
  return payload;
}

describe("extra-params: OpenAI-compat content normalization (#50107)", () => {
  it("flattens text-only user content arrays to plain strings for NVIDIA", () => {
    const payload = capturePayload({
      provider: "nvidia",
      modelId: "nvidia/llama-3.1-nemotron-70b-instruct",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Say hello" }],
        },
      ],
    });

    expect(payload.messages[0].content).toBe("Say hello");
  });

  it("flattens multi-block text-only content into a single string", () => {
    const payload = capturePayload({
      provider: "nvidia",
      modelId: "nvidia/llama-3.1-nemotron-70b-instruct",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "First part. " },
            { type: "text", text: "Second part." },
          ],
        },
      ],
    });

    expect(payload.messages[0].content).toBe("First part. Second part.");
  });

  it("preserves mixed content arrays with images untouched", () => {
    const mixedContent = [
      { type: "text", text: "Describe this image" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
    ];
    const payload = capturePayload({
      provider: "nvidia",
      modelId: "nvidia/llama-3.1-nemotron-70b-instruct",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      messages: [{ role: "user", content: mixedContent }],
    });

    expect(payload.messages[0].content).toEqual(mixedContent);
  });

  it("does not modify already-plain-string content", () => {
    const payload = capturePayload({
      provider: "nvidia",
      modelId: "nvidia/llama-3.1-nemotron-70b-instruct",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      messages: [{ role: "user", content: "Already a string" }],
    });

    expect(payload.messages[0].content).toBe("Already a string");
  });

  it("normalizes system message content arrays to strings", () => {
    const payload = capturePayload({
      provider: "nvidia",
      modelId: "nvidia/llama-3.1-nemotron-70b-instruct",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: "You are a helpful assistant." }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
      ],
    });

    expect(payload.messages[0].content).toBe("You are a helpful assistant.");
    expect(payload.messages[1].content).toBe("Hello");
  });

  it("applies to any openai-completions provider, not just NVIDIA", () => {
    // Test directly via the wrapper to avoid plugin discovery for known
    // provider names (vllm, ollama, etc.) that would time out in tests.
    const payload = captureWrapperDirect({
      api: "openai-completions",
      provider: "my-custom-provider",
      modelId: "some-model",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
      ],
    });

    expect(payload.messages[0].content).toBe("Hello");
  });

  it("skips normalization for non-openai-completions API types", () => {
    // Test the wrapper directly with openai-responses API to verify
    // the api-type gate works correctly.
    const payload = captureWrapperDirect({
      api: "openai-responses",
      provider: "openai",
      modelId: "gpt-5",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
      ],
    });

    // Content should remain as-is since this is not openai-completions
    expect(payload.messages[0].content).toEqual([{ type: "text", text: "Hello" }]);
  });

  it("preserves text blocks with cache_control annotations", () => {
    // OpenRouter Anthropic caching adds cache_control to text blocks.
    // These must NOT be flattened or the caching annotation is lost.
    const annotatedContent = [
      { type: "text", text: "Hello", cache_control: { type: "ephemeral" } },
    ];
    const payload = captureWrapperDirect({
      api: "openai-completions",
      provider: "openrouter",
      modelId: "anthropic/claude-3.5-sonnet",
      messages: [{ role: "user", content: annotatedContent }],
    });

    expect(payload.messages[0].content).toEqual(annotatedContent);
  });

  it("handles empty content arrays gracefully", () => {
    const payload = capturePayload({
      provider: "nvidia",
      modelId: "nvidia/llama-3.1-nemotron-70b-instruct",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      messages: [{ role: "user", content: [] }],
    });

    // Empty arrays should be left alone (not converted to "")
    expect(payload.messages[0].content).toEqual([]);
  });

  it("flattens assistant text-only content arrays to strings", () => {
    const payload = capturePayload({
      provider: "nvidia",
      modelId: "nvidia/llama-3.1-nemotron-70b-instruct",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "I can help with that." }],
        },
      ],
    });

    // Assistant messages with text-only content should also be flattened
    expect(payload.messages[0].content).toBe("I can help with that.");
  });
});
