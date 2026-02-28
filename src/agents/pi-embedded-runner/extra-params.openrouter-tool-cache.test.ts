import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { applyExtraParamsToAgent } from "./extra-params.js";

type StreamPayload = {
  messages: Array<{
    role: string;
    content: unknown;
  }>;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema?: unknown;
    cache_control?: { type: string };
  }>;
};

function runOpenRouterPayloadWithTools(payload: StreamPayload, modelId: string) {
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    options?.onPayload?.(payload);
    return createAssistantMessageEventStream();
  };
  const agent = { streamFn: baseStreamFn };

  applyExtraParamsToAgent(agent, undefined, "openrouter", modelId);

  const model = {
    api: "openai-completions",
    provider: "openrouter",
    id: modelId,
  } as Model<"openai-completions">;
  const context: Context = { messages: [] };

  void agent.streamFn?.(model, context, {});
}

describe("extra-params: OpenRouter Anthropic tool cache_control", () => {
  it("injects cache_control into last tool for OpenRouter Anthropic models", () => {
    const payload: StreamPayload = {
      messages: [{ role: "user", content: "Hello" }],
      tools: [
        { name: "read", description: "Read a file" },
        { name: "write", description: "Write a file" },
        { name: "exec", description: "Execute a command" },
      ],
    };

    runOpenRouterPayloadWithTools(payload, "anthropic/claude-opus-4-6");

    // Only the last tool should have cache_control
    expect(payload.tools?.[0].cache_control).toBeUndefined();
    expect(payload.tools?.[1].cache_control).toBeUndefined();
    expect(payload.tools?.[2].cache_control).toEqual({ type: "ephemeral" });
  });

  it("does not inject tool cache_control for OpenRouter non-Anthropic models", () => {
    const payload: StreamPayload = {
      messages: [{ role: "user", content: "Hello" }],
      tools: [
        { name: "read", description: "Read a file" },
        { name: "write", description: "Write a file" },
      ],
    };

    runOpenRouterPayloadWithTools(payload, "google/gemini-3-pro");

    expect(payload.tools?.[0].cache_control).toBeUndefined();
    expect(payload.tools?.[1].cache_control).toBeUndefined();
  });

  it("handles empty tools array", () => {
    const payload: StreamPayload = {
      messages: [{ role: "user", content: "Hello" }],
      tools: [],
    };

    runOpenRouterPayloadWithTools(payload, "anthropic/claude-opus-4-6");

    expect(payload.tools).toEqual([]);
  });

  it("handles single tool", () => {
    const payload: StreamPayload = {
      messages: [{ role: "user", content: "Hello" }],
      tools: [{ name: "read", description: "Read a file" }],
    };

    runOpenRouterPayloadWithTools(payload, "anthropic/claude-opus-4-6");

    expect(payload.tools?.[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("handles payload without tools property", () => {
    const payload: StreamPayload = {
      messages: [{ role: "user", content: "Hello" }],
    };

    runOpenRouterPayloadWithTools(payload, "anthropic/claude-opus-4-6");

    expect(payload.tools).toBeUndefined();
  });

  it("does not overwrite existing cache_control on tools", () => {
    const payload: StreamPayload = {
      messages: [{ role: "user", content: "Hello" }],
      tools: [
        { name: "read", description: "Read a file", cache_control: { type: "ephemeral" } },
        { name: "write", description: "Write a file" },
      ],
    };

    runOpenRouterPayloadWithTools(payload, "anthropic/claude-opus-4-6");

    // First tool keeps its existing cache_control
    expect(payload.tools?.[0].cache_control).toEqual({ type: "ephemeral" });
    // Last tool gets cache_control added
    expect(payload.tools?.[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("handles claude-sonnet models", () => {
    const payload: StreamPayload = {
      messages: [{ role: "user", content: "Hello" }],
      tools: [{ name: "read", description: "Read a file" }],
    };

    runOpenRouterPayloadWithTools(payload, "anthropic/claude-sonnet-4");

    expect(payload.tools?.[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("handles claude-haiku models", () => {
    const payload: StreamPayload = {
      messages: [{ role: "user", content: "Hello" }],
      tools: [{ name: "read", description: "Read a file" }],
    };

    runOpenRouterPayloadWithTools(payload, "anthropic/claude-3.5-haiku");

    expect(payload.tools?.[0].cache_control).toEqual({ type: "ephemeral" });
  });
});
