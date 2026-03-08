import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { applyExtraParamsToAgent } from "./extra-params.js";

type StreamPayload = {
  messages: Array<{
    role: string;
    content: unknown;
  }>;
};

function runPayload(
  payload: StreamPayload,
  provider: string,
  modelId: string,
  cfg?: OpenClawConfig,
) {
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    options?.onPayload?.(payload);
    return createAssistantMessageEventStream();
  };
  const agent = { streamFn: baseStreamFn };

  applyExtraParamsToAgent(agent, cfg, provider, modelId);

  const model = {
    api: "openai-completions",
    provider,
    id: modelId,
  } as Model<"openai-completions">;
  const context: Context = { messages: [] };

  void agent.streamFn?.(model, context, {});
}

function cfgWithCacheStyle(
  provider: string,
  modelId: string,
  value: string | null,
): OpenClawConfig {
  return {
    agents: {
      defaults: {
        models: {
          [`${provider}/${modelId}`]: {
            params: { cacheStyle: value },
          },
        },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("extra-params: cacheStyle param", () => {
  it("injects cache_control when cacheStyle is 'anthropic'", () => {
    const payload = {
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
      ],
    };

    const cfg = cfgWithCacheStyle("bailian", "qwen3.5-plus", "anthropic");
    runPayload(payload, "bailian", "qwen3.5-plus", cfg);

    expect(payload.messages[0].content).toEqual([
      { type: "text", text: "You are a helpful assistant.", cache_control: { type: "ephemeral" } },
    ]);
    expect(payload.messages[1].content).toEqual([
      { type: "text", text: "Hello", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("does not inject cache_control without cacheStyle param", () => {
    const payload = {
      messages: [{ role: "system", content: "You are a helpful assistant." }],
    };

    runPayload(payload, "bailian", "qwen3.5-plus");

    expect(payload.messages[0].content).toBe("You are a helpful assistant.");
  });

  it("null cacheStyle disables OpenRouter auto-detection", () => {
    const payload = {
      messages: [{ role: "system", content: "You are a helpful assistant." }],
    };

    const cfg = cfgWithCacheStyle("openrouter", "anthropic/claude-sonnet-4", null);
    runPayload(payload, "openrouter", "anthropic/claude-sonnet-4", cfg);

    expect(payload.messages[0].content).toBe("You are a helpful assistant.");
  });

  it("OpenRouter Anthropic auto-detection only injects system cache_control", () => {
    const payload = {
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
      ],
    };

    runPayload(payload, "openrouter", "anthropic/claude-sonnet-4");

    expect(payload.messages[0].content).toEqual([
      { type: "text", text: "You are a helpful assistant.", cache_control: { type: "ephemeral" } },
    ]);
    expect(payload.messages[1].content).toBe("Hello");
  });

  it("injects cache_control on last user message", () => {
    const payload = {
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello!" },
        { role: "user", content: "How are you?" },
      ],
    };

    const cfg = cfgWithCacheStyle("bailian", "qwen3.5-plus", "anthropic");
    runPayload(payload, "bailian", "qwen3.5-plus", cfg);

    expect(payload.messages[0].content).toEqual([
      { type: "text", text: "You are a helpful assistant.", cache_control: { type: "ephemeral" } },
    ]);
    expect(payload.messages[1].content).toBe("Hi");
    expect(payload.messages[2].content).toBe("Hello!");
    expect(payload.messages[3].content).toEqual([
      { type: "text", text: "How are you?", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("injects cache_control on last text block of array content in user message", () => {
    const payload = {
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
            { type: "text", text: "Describe this image" },
          ],
        },
      ],
    };

    const cfg = cfgWithCacheStyle("bailian", "qwen3.5-plus", "anthropic");
    runPayload(payload, "bailian", "qwen3.5-plus", cfg);

    expect((payload.messages[1].content as unknown[])[0]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,abc" },
    });
    expect((payload.messages[1].content as unknown[])[1]).toEqual({
      type: "text",
      text: "Describe this image",
      cache_control: { type: "ephemeral" },
    });
  });
});
