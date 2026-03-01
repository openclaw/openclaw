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

function runOpenRouterPayload(payload: StreamPayload, modelId: string, cfg?: OpenClawConfig) {
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    options?.onPayload?.(payload);
    return createAssistantMessageEventStream();
  };
  const agent = { streamFn: baseStreamFn };

  applyExtraParamsToAgent(agent, cfg, "openrouter", modelId);

  const model = {
    api: "openai-completions",
    provider: "openrouter",
    id: modelId,
  } as Model<"openai-completions">;
  const context: Context = { messages: [] };

  void agent.streamFn?.(model, context, {});
}

describe("extra-params: OpenRouter Anthropic cache_control", () => {
  it("injects cache_control into system message for OpenRouter Anthropic models", () => {
    const payload = {
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
      ],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6");

    expect(payload.messages[0].content).toEqual([
      { type: "text", text: "You are a helpful assistant.", cache_control: { type: "ephemeral" } },
    ]);
    expect(payload.messages[1].content).toBe("Hello");
  });

  it("adds cache_control to last content block when system message is already array", () => {
    const payload = {
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "Part 1" },
            { type: "text", text: "Part 2" },
          ],
        },
      ],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6");

    const content = payload.messages[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "text", text: "Part 1" });
    expect(content[1]).toEqual({
      type: "text",
      text: "Part 2",
      cache_control: { type: "ephemeral" },
    });
  });

  it("does not inject cache_control for OpenRouter non-Anthropic models", () => {
    const payload = {
      messages: [{ role: "system", content: "You are a helpful assistant." }],
    };

    runOpenRouterPayload(payload, "google/gemini-3-pro");

    expect(payload.messages[0].content).toBe("You are a helpful assistant.");
  });

  it("leaves payload unchanged when no system message exists", () => {
    const payload = {
      messages: [{ role: "user", content: "Hello" }],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6");

    expect(payload.messages[0].content).toBe("Hello");
  });

  it("respects cacheRetention: none - does not inject cache_control", () => {
    const payload = {
      messages: [{ role: "system", content: "You are a helpful assistant." }],
    };

    const cfg = {
      agents: {
        defaults: {
          models: {
            "openrouter/anthropic/claude-opus-4-6": {
              params: { cacheRetention: "none" },
            },
          },
        },
      },
    } as OpenClawConfig;

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6", cfg);

    expect(payload.messages[0].content).toBe("You are a helpful assistant.");
  });

  it("respects cacheRetention: short - injects ephemeral cache_control", () => {
    const payload = {
      messages: [{ role: "system", content: "You are a helpful assistant." }],
    };

    const cfg = {
      agents: {
        defaults: {
          models: {
            "openrouter/anthropic/claude-opus-4-6": {
              params: { cacheRetention: "short" },
            },
          },
        },
      },
    } as OpenClawConfig;

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6", cfg);

    expect(payload.messages[0].content).toEqual([
      { type: "text", text: "You are a helpful assistant.", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("respects cacheRetention: long - injects persistent cache_control", () => {
    const payload = {
      messages: [{ role: "system", content: "You are a helpful assistant." }],
    };

    const cfg = {
      agents: {
        defaults: {
          models: {
            "openrouter/anthropic/claude-opus-4-6": {
              params: { cacheRetention: "long" },
            },
          },
        },
      },
    } as OpenClawConfig;

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6", cfg);

    expect(payload.messages[0].content).toEqual([
      { type: "text", text: "You are a helpful assistant.", cache_control: { type: "persistent" } },
    ]);
  });

  it("defaults to ephemeral when cacheRetention is not configured", () => {
    // This is the existing behavior - should default to ephemeral (short)
    const payload = {
      messages: [{ role: "system", content: "You are a helpful assistant." }],
    };

    // No cfg provided - should default to ephemeral
    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6");

    expect(payload.messages[0].content).toEqual([
      { type: "text", text: "You are a helpful assistant.", cache_control: { type: "ephemeral" } },
    ]);
  });
});
