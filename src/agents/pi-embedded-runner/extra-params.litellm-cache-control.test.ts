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

function runLiteLLMPayload(
  payload: StreamPayload,
  modelId: string,
  cacheRetention?: "none" | "short" | "long",
) {
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    options?.onPayload?.(payload);
    return createAssistantMessageEventStream();
  };
  const agent = { streamFn: baseStreamFn };

  const cfg = cacheRetention
    ? {
        agents: {
          defaults: {
            models: {
              [`litellm/${modelId}`]: {
                params: { cacheRetention },
              },
            },
          },
        },
      }
    : undefined;

  applyExtraParamsToAgent(agent, cfg as never, "litellm", modelId);

  const model = {
    api: "openai-completions",
    provider: "litellm",
    id: modelId,
  } as Model<"openai-completions">;
  const context: Context = { messages: [] };

  void agent.streamFn?.(model, context, {});
}

describe("extra-params: LiteLLM Anthropic cache_control (refs #37966)", () => {
  it("injects cache_control when cacheRetention is explicitly configured for a claude-* model", () => {
    const payload = {
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
      ],
    };

    runLiteLLMPayload(payload, "claude-opus-4-6", "long");

    expect(payload.messages[0].content).toEqual([
      { type: "text", text: "You are a helpful assistant.", cache_control: { type: "ephemeral" } },
    ]);
    expect(payload.messages[1].content).toBe("Hello");
  });

  it("injects cache_control for anthropic/claude-* model IDs", () => {
    const payload = {
      messages: [{ role: "system", content: "System prompt." }],
    };

    runLiteLLMPayload(payload, "anthropic/claude-3-5-sonnet", "short");

    expect(payload.messages[0].content).toEqual([
      { type: "text", text: "System prompt.", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("injects cache_control for anthropic.claude-* (Bedrock-style) model IDs via LiteLLM", () => {
    const payload = {
      messages: [{ role: "system", content: "Bedrock-style prompt." }],
    };

    runLiteLLMPayload(payload, "anthropic.claude-3-5-sonnet-20241022-v2:0", "short");

    expect(payload.messages[0].content).toEqual([
      {
        type: "text",
        text: "Bedrock-style prompt.",
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("does NOT inject cache_control when cacheRetention is not configured", () => {
    const payload = {
      messages: [{ role: "system", content: "You are a helpful assistant." }],
    };

    // No cacheRetention config — wrapper should not be applied
    runLiteLLMPayload(payload, "claude-opus-4-6", undefined);

    expect(payload.messages[0].content).toBe("You are a helpful assistant.");
  });

  it("does NOT inject cache_control when cacheRetention is explicitly 'none'", () => {
    const payload = {
      messages: [{ role: "system", content: "You are a helpful assistant." }],
    };

    // cacheRetention: "none" means the user opted out — must not inject cache_control
    runLiteLLMPayload(payload, "claude-opus-4-6", "none");

    expect(payload.messages[0].content).toBe("You are a helpful assistant.");
  });

  it("does NOT inject cache_control for non-Anthropic LiteLLM models", () => {
    const payload = {
      messages: [{ role: "system", content: "You are a helpful assistant." }],
    };

    runLiteLLMPayload(payload, "gpt-4o", "short");

    expect(payload.messages[0].content).toBe("You are a helpful assistant.");
  });

  it("adds cache_control to last block when system message content is already an array", () => {
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

    runLiteLLMPayload(payload, "claude-opus-4-6", "long");

    const content = payload.messages[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "text", text: "Part 1" });
    expect(content[1]).toEqual({
      type: "text",
      text: "Part 2",
      cache_control: { type: "ephemeral" },
    });
  });

  it("leaves payload unchanged when there is no system message", () => {
    const payload = {
      messages: [{ role: "user", content: "Hello" }],
    };

    runLiteLLMPayload(payload, "claude-opus-4-6", "long");

    expect(payload.messages[0].content).toBe("Hello");
  });
});
