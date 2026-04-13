import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Context, Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { wrapStreamFnWithSplitModelRouting } from "./split-model-stream.js";

function createMockModel(overrides: Partial<Model<Api>>): Model<Api> {
  return {
    api: "anthropic-messages",
    provider: "anthropic",
    id: "claude-sonnet-4-20250514",
    name: "anthropic/claude-sonnet-4-20250514",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
    ...overrides,
  } as Model<Api>;
}

describe("split model routing stream wrapper", () => {
  it("routes chat turns to the primary model", () => {
    const calls: Array<{ modelId: string }> = [];
    const baseStreamFn: StreamFn = (model, _context, _options) => {
      calls.push({ modelId: (model as Model<Api>).id });
      return createAssistantMessageEventStream();
    };

    const primaryModel = createMockModel({ id: "qwen2.5-7b", provider: "ollama" });
    const toolModel = createMockModel({ id: "claude-sonnet-4-20250514", provider: "anthropic" });

    const wrapped = wrapStreamFnWithSplitModelRouting({
      innerStreamFn: baseStreamFn,
      toolModel,
      primaryProvider: "ollama",
      toolProvider: "anthropic",
    });

    // Chat turn: last message is from user
    const chatContext: Context = {
      messages: [{ role: "user", content: "Hello" }],
    };
    void wrapped(primaryModel, chatContext, {});

    expect(calls).toHaveLength(1);
    expect(calls[0].modelId).toBe("qwen2.5-7b");
  });

  it("routes tool-continuation turns to the tool model", () => {
    const calls: Array<{ modelId: string }> = [];
    const baseStreamFn: StreamFn = (model, _context, _options) => {
      calls.push({ modelId: (model as Model<Api>).id });
      return createAssistantMessageEventStream();
    };

    const primaryModel = createMockModel({ id: "qwen2.5-7b", provider: "ollama" });
    const toolModel = createMockModel({ id: "claude-sonnet-4-20250514", provider: "anthropic" });

    const wrapped = wrapStreamFnWithSplitModelRouting({
      innerStreamFn: baseStreamFn,
      toolModel,
      primaryProvider: "ollama",
      toolProvider: "anthropic",
    });

    // Tool continuation: last message is a tool result
    const toolContext: Context = {
      messages: [
        { role: "user", content: "Read the file" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tc_1", name: "read", input: {} }],
        },
        { role: "tool", content: "file contents here" },
      ],
    };
    void wrapped(primaryModel, toolContext, {});

    expect(calls).toHaveLength(1);
    expect(calls[0].modelId).toBe("claude-sonnet-4-20250514");
  });

  it("routes toolResult role messages to the tool model", () => {
    const calls: Array<{ modelId: string }> = [];
    const baseStreamFn: StreamFn = (model, _context, _options) => {
      calls.push({ modelId: (model as Model<Api>).id });
      return createAssistantMessageEventStream();
    };

    const primaryModel = createMockModel({ id: "qwen2.5-7b", provider: "ollama" });
    const toolModel = createMockModel({ id: "claude-sonnet-4-20250514", provider: "anthropic" });

    const wrapped = wrapStreamFnWithSplitModelRouting({
      innerStreamFn: baseStreamFn,
      toolModel,
      primaryProvider: "ollama",
      toolProvider: "anthropic",
    });

    // Some providers use "toolResult" role instead of "tool"
    const toolResultContext: Context = {
      messages: [
        { role: "user", content: "Read the file" },
        { role: "toolResult", content: "file contents here" },
      ],
    };
    void wrapped(primaryModel, toolResultContext, {});

    expect(calls).toHaveLength(1);
    expect(calls[0].modelId).toBe("claude-sonnet-4-20250514");
  });

  it("returns to primary model after tool continuation completes", () => {
    const calls: Array<{ modelId: string }> = [];
    const baseStreamFn: StreamFn = (model, _context, _options) => {
      calls.push({ modelId: (model as Model<Api>).id });
      return createAssistantMessageEventStream();
    };

    const primaryModel = createMockModel({ id: "qwen2.5-7b", provider: "ollama" });
    const toolModel = createMockModel({ id: "claude-sonnet-4-20250514", provider: "anthropic" });

    const wrapped = wrapStreamFnWithSplitModelRouting({
      innerStreamFn: baseStreamFn,
      toolModel,
      primaryProvider: "ollama",
      toolProvider: "anthropic",
    });

    // First: tool continuation turn
    void wrapped(primaryModel, {
      messages: [{ role: "tool", content: "result" }],
    } as Context, {});

    // Second: back to chat turn
    void wrapped(primaryModel, {
      messages: [{ role: "user", content: "Thanks" }],
    } as Context, {});

    expect(calls).toHaveLength(2);
    expect(calls[0].modelId).toBe("claude-sonnet-4-20250514");
    expect(calls[1].modelId).toBe("qwen2.5-7b");
  });

  it("uses primary model when messages are empty", () => {
    const calls: Array<{ modelId: string }> = [];
    const baseStreamFn: StreamFn = (model, _context, _options) => {
      calls.push({ modelId: (model as Model<Api>).id });
      return createAssistantMessageEventStream();
    };

    const primaryModel = createMockModel({ id: "qwen2.5-7b", provider: "ollama" });
    const toolModel = createMockModel({ id: "claude-sonnet-4-20250514", provider: "anthropic" });

    const wrapped = wrapStreamFnWithSplitModelRouting({
      innerStreamFn: baseStreamFn,
      toolModel,
      primaryProvider: "ollama",
      toolProvider: "anthropic",
    });

    void wrapped(primaryModel, { messages: [] } as Context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0].modelId).toBe("qwen2.5-7b");
  });

  it("passes through options unchanged", () => {
    const capturedOptions: unknown[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      capturedOptions.push(options);
      return createAssistantMessageEventStream();
    };

    const primaryModel = createMockModel({ id: "qwen2.5-7b", provider: "ollama" });
    const toolModel = createMockModel({ id: "claude-sonnet-4-20250514", provider: "anthropic" });

    const wrapped = wrapStreamFnWithSplitModelRouting({
      innerStreamFn: baseStreamFn,
      toolModel,
      primaryProvider: "ollama",
      toolProvider: "anthropic",
    });

    const opts = { temperature: 0.7 };
    void wrapped(primaryModel, {
      messages: [{ role: "tool", content: "result" }],
    } as Context, opts);

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]).toBe(opts);
  });
});
