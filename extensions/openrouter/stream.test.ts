import type { StreamFn } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { wrapOpenRouterProviderStream } from "./stream.js";

describe("wrapOpenRouterProviderStream", () => {
  it("keeps assistant messages pinned to the configured OpenRouter alias", async () => {
    const baseStreamFn: StreamFn = (model) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hi" }],
            api: model.api,
            provider: model.provider,
            model: "deepseek/deepseek-chat-v3-20260117",
            usage: {
              input: 0,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 1,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: Date.now(),
          },
        });
        stream.end();
      });
      return stream;
    };

    const wrapped = wrapOpenRouterProviderStream({
      streamFn: baseStreamFn,
      modelId: "deepseek/deepseek-v3.2",
      thinkingLevel: "adaptive",
      extraParams: undefined,
    } as never)!;

    const stream = wrapped(
      {
        api: "openai-completions",
        provider: "openrouter",
        id: "deepseek/deepseek-v3.2",
      } as never,
      { messages: [] },
      {},
    );

    const events = [] as Array<Record<string, unknown>>;
    for await (const event of stream) {
      events.push(event as Record<string, unknown>);
    }
    const result = await stream.result();

    expect((events[0]?.message as { model?: string }).model).toBe("deepseek/deepseek-v3.2");
    expect(result?.model).toBe("deepseek/deepseek-v3.2");
  });

  it("normalizes error events to the configured alias too", async () => {
    const baseStreamFn: StreamFn = (model) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: "anthropic/claude-4.5-sonnet-20250929",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "error",
            errorMessage: "boom",
            timestamp: Date.now(),
          },
        });
        stream.end();
      });
      return stream;
    };

    const wrapped = wrapOpenRouterProviderStream({
      streamFn: baseStreamFn,
      modelId: "anthropic/claude-sonnet-4.5",
      thinkingLevel: "adaptive",
      extraParams: undefined,
    } as never)!;

    const stream = wrapped(
      {
        api: "openai-completions",
        provider: "openrouter",
        id: "anthropic/claude-sonnet-4.5",
      } as never,
      { messages: [] },
      {},
    );

    const events = [] as Array<Record<string, unknown>>;
    for await (const event of stream) {
      events.push(event as Record<string, unknown>);
    }

    expect((events[0]?.error as { model?: string }).model).toBe("anthropic/claude-sonnet-4.5");
  });
});
