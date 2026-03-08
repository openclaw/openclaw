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
};

function runOpenRouterPayload(payload: StreamPayload, modelId: string) {
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

  it("skips cache_control injection for thinking blocks in system messages", () => {
    const payload = {
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "System prompt" },
            { type: "thinking", thinking: "Internal reasoning" },
          ],
        },
      ],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6");

    const content = payload.messages[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "text", text: "System prompt" });
    // thinking block should not have cache_control added
    expect(content[1]).toEqual({ type: "thinking", thinking: "Internal reasoning" });
    expect(content[1].cache_control).toBeUndefined();
  });

  it("removes cache_control from thinking blocks in assistant messages", () => {
    const payload = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me think", cache_control: { type: "ephemeral" } },
            { type: "text", text: "Here is my response" },
          ],
        },
      ],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6");

    const content = payload.messages[0].content as Array<Record<string, unknown>>;
    // cache_control should be removed from thinking block
    expect(content[0]).toEqual({ type: "thinking", thinking: "Let me think" });
    expect(content[0].cache_control).toBeUndefined();
    // text block should remain unchanged
    expect(content[1]).toEqual({ type: "text", text: "Here is my response" });
  });

  it("removes cache_control from redacted_thinking blocks in assistant messages", () => {
    const payload = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "redacted_thinking",
              redacted_thinking: "...",
              cache_control: { type: "ephemeral" },
            },
            { type: "text", text: "Response" },
          ],
        },
      ],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6");

    const content = payload.messages[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "redacted_thinking", redacted_thinking: "..." });
    expect(content[0].cache_control).toBeUndefined();
  });

  it("handles mixed content with thinking blocks correctly", () => {
    const payload = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Before thinking" },
            { type: "thinking", thinking: "Reasoning", cache_control: { type: "ephemeral" } },
            { type: "text", text: "After thinking" },
          ],
        },
      ],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6");

    const content = payload.messages[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "text", text: "Before thinking" });
    expect(content[1]).toEqual({ type: "thinking", thinking: "Reasoning" });
    expect(content[1].cache_control).toBeUndefined();
    expect(content[2]).toEqual({ type: "text", text: "After thinking" });
  });
});
