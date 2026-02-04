import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { AssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  applyExtraParamsToAgent,
  calculateCappedMaxTokens,
  estimateInputTokens,
  resolveExtraParams,
} from "./pi-embedded-runner.js";

describe("resolveExtraParams", () => {
  it("returns undefined with no model config", () => {
    const result = resolveExtraParams({
      cfg: undefined,
      provider: "zai",
      modelId: "glm-4.7",
    });

    expect(result).toBeUndefined();
  });

  it("returns params for exact provider/model key", () => {
    const result = resolveExtraParams({
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-4": {
                params: {
                  temperature: 0.7,
                  maxTokens: 2048,
                },
              },
            },
          },
        },
      },
      provider: "openai",
      modelId: "gpt-4",
    });

    expect(result).toEqual({
      temperature: 0.7,
      maxTokens: 2048,
    });
  });

  it("ignores unrelated model entries", () => {
    const result = resolveExtraParams({
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-4": {
                params: {
                  temperature: 0.7,
                },
              },
            },
          },
        },
      },
      provider: "openai",
      modelId: "gpt-4.1-mini",
    });

    expect(result).toBeUndefined();
  });
});

describe("applyExtraParamsToAgent", () => {
  it("adds OpenRouter attribution headers to stream options", () => {
    const calls: Array<SimpleStreamOptions | undefined> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push(options);
      return new AssistantMessageEventStream();
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "openrouter", "openrouter/auto");

    const model = {
      api: "openai-completions",
      provider: "openrouter",
      id: "openrouter/auto",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, { headers: { "X-Custom": "1" } });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers).toEqual({
      "HTTP-Referer": "https://openclaw.ai",
      "X-Title": "OpenClaw",
      "X-Custom": "1",
    });
  });

  it("caps maxTokens when input + maxTokens would exceed context window", () => {
    const calls: Array<SimpleStreamOptions | undefined> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push(options);
      return new AssistantMessageEventStream();
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "anthropic", "claude-opus-4-5");

    // Model with 10000 token context window and default maxTokens of 5000
    const model = {
      api: "anthropic-messages",
      provider: "anthropic",
      id: "claude-opus-4-5",
      contextWindow: 10000,
      maxTokens: 5000,
    } as Model<"anthropic-messages">;

    // Context with ~8000 tokens (leaving only ~2000 for output)
    const context: Context = {
      system: "x".repeat(3000), // ~750 tokens
      messages: [
        { role: "user", content: "y".repeat(29000) }, // ~7250 tokens
      ],
    };

    void agent.streamFn?.(model, context, { maxTokens: 5000 });

    expect(calls).toHaveLength(1);
    // Should be capped below 5000 since only ~2000 tokens remain
    expect(calls[0]?.maxTokens).toBeLessThan(5000);
    expect(calls[0]?.maxTokens).toBeGreaterThan(0);
  });

  it("does not modify maxTokens when there is sufficient context space", () => {
    const calls: Array<SimpleStreamOptions | undefined> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push(options);
      return new AssistantMessageEventStream();
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "anthropic", "claude-opus-4-5");

    // Model with 200000 token context window
    const model = {
      api: "anthropic-messages",
      provider: "anthropic",
      id: "claude-opus-4-5",
      contextWindow: 200000,
      maxTokens: 8192,
    } as Model<"anthropic-messages">;

    // Small context with only ~500 tokens
    const context: Context = {
      system: "Hello",
      messages: [{ role: "user", content: "How are you?" }],
    };

    void agent.streamFn?.(model, context, { maxTokens: 8192 });

    expect(calls).toHaveLength(1);
    // Should not modify maxTokens since there's plenty of space
    expect(calls[0]?.maxTokens).toBeUndefined();
  });
});

describe("estimateInputTokens", () => {
  it("estimates tokens for system prompt", () => {
    const tokens = estimateInputTokens({
      system: "You are a helpful assistant.",
    });
    expect(tokens).toBeGreaterThan(0);
  });

  it("estimates tokens for messages", () => {
    const tokens = estimateInputTokens({
      messages: [
        { role: "user", content: "Hello!" },
        { role: "assistant", content: "Hi there!" },
      ],
    });
    expect(tokens).toBeGreaterThan(0);
  });

  it("combines system and message tokens", () => {
    const systemOnly = estimateInputTokens({ system: "System prompt" });
    const messagesOnly = estimateInputTokens({
      messages: [{ role: "user", content: "User message" }],
    });
    const combined = estimateInputTokens({
      system: "System prompt",
      messages: [{ role: "user", content: "User message" }],
    });

    // Combined should be approximately the sum (with safety margin)
    expect(combined).toBeGreaterThanOrEqual(systemOnly);
    expect(combined).toBeGreaterThanOrEqual(messagesOnly);
  });

  it("returns 0 for empty context", () => {
    const tokens = estimateInputTokens({});
    expect(tokens).toBe(0);
  });
});

describe("calculateCappedMaxTokens", () => {
  it("caps maxTokens when it would exceed remaining context", () => {
    const result = calculateCappedMaxTokens({
      requestedMaxTokens: 10000,
      modelMaxTokens: 8192,
      contextWindow: 20000,
      inputTokens: 15000,
    });
    // Remaining: 20000 - 15000 = 5000
    expect(result).toBe(5000);
  });

  it("returns requested maxTokens when within remaining context", () => {
    const result = calculateCappedMaxTokens({
      requestedMaxTokens: 5000,
      modelMaxTokens: 8192,
      contextWindow: 200000,
      inputTokens: 10000,
    });
    expect(result).toBe(5000);
  });

  it("falls back to model maxTokens when no request specified", () => {
    const result = calculateCappedMaxTokens({
      requestedMaxTokens: undefined,
      modelMaxTokens: 8192,
      contextWindow: 200000,
      inputTokens: 10000,
    });
    expect(result).toBe(8192);
  });

  it("returns minimum output tokens when context nearly full", () => {
    const result = calculateCappedMaxTokens({
      requestedMaxTokens: 10000,
      modelMaxTokens: 8192,
      contextWindow: 20000,
      inputTokens: 19500,
    });
    // Remaining: 20000 - 19500 = 500, which is less than MIN_OUTPUT_TOKENS (1024)
    expect(result).toBe(1024);
  });

  it("uses remaining tokens when no maxTokens specified", () => {
    const result = calculateCappedMaxTokens({
      requestedMaxTokens: undefined,
      modelMaxTokens: undefined,
      contextWindow: 20000,
      inputTokens: 15000,
    });
    expect(result).toBe(5000);
  });
});
