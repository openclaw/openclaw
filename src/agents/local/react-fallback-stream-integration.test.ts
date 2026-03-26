import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { updateModelCapability } from "./capabilities-cache.js";
import { wrapStreamFnWithReActFallback } from "./react-fallback-stream.js";

const FIXTURES_DIR = path.resolve(__dirname, "../../../test-fixtures/streams/local-models");

/**
 * Creates a mock StreamFn that perfectly mimics how OpenClaw native providers (Ollama/LMStudio)
 * return a stream when the model has finished generating text.
 */
function createMockNativeStreamFn(mockOutputText: string): StreamFn {
  return (_model, _context, _options) => {
    const stream = createAssistantMessageEventStream();

    // Simulate async network delay
    setTimeout(() => {
      stream.push({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: mockOutputText }],
          stopReason: "stop",
          api: "test",
          provider: "test",
          model: "test",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          timestamp: Date.now(),
          // eslint-disable-next-line no-explicit-any
        } as unknown as any,
      });
      stream.end();
    }, 10);

    return stream;
  };
}

type DoneEvent = {
  type: "done";
  reason: string;
  message: {
    content: Array<{ type: string; text?: string; name?: string; arguments?: unknown }>;
  };
};

let configDir: string;

describe("ReAct Fallback Stream E2E Integration", () => {
  beforeAll(async () => {
    configDir = path.join(os.tmpdir(), `openclaw-test-${Date.now()}`);
    await fs.mkdir(path.join(configDir, "mpm"), { recursive: true });
  });

  afterAll(async () => {
    if (existsSync(configDir)) {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it("should process LMStudio Qwen/DeepSeek reasoning streams and extract valid ToolCalls while stripping <think>", async () => {
    const fixtureText = await fs.readFile(
      path.join(FIXTURES_DIR, "qwen3-lmstudio-think.txt"),
      "utf-8",
    );

    const nativeStreamFn = createMockNativeStreamFn(fixtureText);
    const wrappedStreamFn = wrapStreamFnWithReActFallback(nativeStreamFn, {
      modelId: "deepseek-r1",
      providerId: "deepseek-r1",
      providerType: "lmstudio",
      toolFallback: "react",
    });

    const stream = await wrappedStreamFn(
      // eslint-disable-next-line no-explicit-any
      { id: "deepseek-r1", api: "test", provider: "lmstudio" } as unknown as any,
      // eslint-disable-next-line no-explicit-any
      { tools: [{ name: "get_weather", description: "testing" }] } as unknown as any,
      {},
    );

    const events: unknown[] = [];
    for await (const chunk of stream) {
      events.push(chunk);
    }

    expect(events).toHaveLength(1);
    const doneEvent = events[0] as DoneEvent;

    expect(doneEvent.type).toBe("done");
    expect(doneEvent.reason).toBe("toolUse"); // Successfully intercepted and upgraded reason

    const content = doneEvent.message.content;
    expect(content).toBeInstanceOf(Array);

    // The `<think>` tags MUST be gone
    const textPart = content.find((p) => p.type === "text") as { type: string; text: string };
    expect(textPart).toBeDefined();
    expect(textPart.text).not.toContain("<think>");
    expect(textPart.text).toContain("Here is my internal reasoning."); // text after think tag

    // The ToolCall MUST be present
    const toolCallPart = content.find((p) => p.type === "toolCall") as {
      type: string;
      name: string;
      arguments: unknown;
    };
    expect(toolCallPart).toBeDefined();
    expect(toolCallPart.name).toBe("get_weather");
    expect(toolCallPart.arguments).toEqual({ location: "San Francisco, CA" });
  });

  it("should process Ollama LLaMA3 React streams and extract valid Action calls", async () => {
    const fixtureText = await fs.readFile(
      path.join(FIXTURES_DIR, "llama3-react-action.txt"),
      "utf-8",
    );

    const nativeStreamFn = createMockNativeStreamFn(fixtureText);
    const wrappedStreamFn = wrapStreamFnWithReActFallback(nativeStreamFn, {
      modelId: "llama3",
      providerId: "llama3",
      providerType: "ollama",
      toolFallback: "react",
    });

    const stream = await wrappedStreamFn(
      // eslint-disable-next-line no-explicit-any
      { id: "llama3", api: "test", provider: "ollama" } as unknown as any,
      // eslint-disable-next-line no-explicit-any
      { tools: [{ name: "codebase_search", description: "testing" }] } as unknown as any,
      {},
    );

    const events: unknown[] = [];
    for await (const chunk of stream) {
      events.push(chunk);
    }

    expect(events).toHaveLength(1);
    const doneEvent = events[0] as DoneEvent;

    expect(doneEvent.type).toBe("done");
    expect(doneEvent.reason).toBe("toolUse");

    const content = doneEvent.message.content;
    const textPart = content.find((p) => p.type === "text") as { type: string; text: string };
    expect(textPart.text).toContain("Thought: The user is asking");
    expect(textPart.text).toContain("I will wait for the result");
    expect(textPart.text).not.toContain("Action: {");

    const toolCallPart = content.find((p) => p.type === "toolCall") as {
      type: string;
      name: string;
      arguments: unknown;
    };
    expect(toolCallPart).toBeDefined();
    expect(toolCallPart.name).toBe("codebase_search");
    expect(toolCallPart.arguments).toEqual({ query: "auth" });
  });

  it("should bypass fallback safely if model has native capabilities and toolFallback is auto", async () => {
    // Modify model ID to simulate a native-capable model according to REAL heuristics (e.g. qwen2-coder)
    const nativeStreamFn = createMockNativeStreamFn("Native Output Here");
    const wrappedStreamFn = wrapStreamFnWithReActFallback(nativeStreamFn, {
      modelId: "qwen2-coder",
      providerId: "qwen2-coder",
      providerType: "openai-compatible",
      toolFallback: "auto", // Auto delegates to discovery
    });

    const stream = await wrappedStreamFn(
      // eslint-disable-next-line no-explicit-any
      { id: "qwen2-coder", api: "test" } as unknown as any,
      // eslint-disable-next-line no-explicit-any
      { tools: [{ name: "native_tool", description: "test" }] } as unknown as any,
      {},
    );

    const events: unknown[] = [];
    for await (const chunk of stream) {
      events.push(chunk);
    }

    const doneEvent = events[0] as DoneEvent;
    const content = doneEvent.message.content;
    const textPart = content.find((p) => p.type === "text") as { type: string; text: string };
    expect(textPart.text).toBe("Native Output Here");
    expect(doneEvent.reason).toBe("stop");
  });

  it("should handle multiple consecutive tool calls", async () => {
    const fixtureText = await fs.readFile(path.join(FIXTURES_DIR, "multiple-actions.txt"), "utf-8");
    const nativeStreamFn = createMockNativeStreamFn(fixtureText);
    const wrappedStreamFn = wrapStreamFnWithReActFallback(nativeStreamFn, {
      modelId: "llama3",
      providerId: "llama3",
      providerType: "ollama",
      toolFallback: "react",
    });

    const stream = await wrappedStreamFn(
      // eslint-disable-next-line no-explicit-any
      { id: "llama3", api: "test", provider: "ollama" } as unknown as any,
      {
        tools: [
          { name: "get_weather", description: "testing" },
          { name: "get_time", description: "testing" },
        ],
        // eslint-disable-next-line no-explicit-any
      } as unknown as any,
      {},
    );
    const events: unknown[] = [];
    for await (const chunk of stream) {
      events.push(chunk);
    }

    const doneEvent = events[0] as DoneEvent;
    const content = doneEvent.message.content;
    const toolCalls = content.filter((p) => p.type === "toolCall") as Array<{
      type: string;
      name: string;
      arguments: unknown;
    }>;
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].name).toBe("get_weather");
    expect(toolCalls[1].name).toBe("get_time");

    // Check text retention
    const textPart = (content.find((p) => p.type === "text") as { type: string; text: string })
      .text;
    expect(textPart).toContain("Thought: I need to check both weather and time.");
    expect(textPart).toContain("I'll wait for the data.");
  });

  it("should cleanly ignore and return malformed JSON as text", async () => {
    const fixtureText = await fs.readFile(path.join(FIXTURES_DIR, "malformed-json.txt"), "utf-8");
    const nativeStreamFn = createMockNativeStreamFn(fixtureText);
    const wrappedStreamFn = wrapStreamFnWithReActFallback(nativeStreamFn, {
      modelId: "llama3",
      providerId: "llama3",
      providerType: "ollama",
      toolFallback: "react",
    });

    const stream = await wrappedStreamFn(
      // eslint-disable-next-line no-explicit-any
      { id: "llama3", api: "test", provider: "ollama" } as unknown as any,
      // eslint-disable-next-line no-explicit-any
      { tools: [{ name: "broken", description: "testing" }] } as unknown as any,
      {},
    );
    const events: unknown[] = [];
    for await (const chunk of stream) {
      events.push(chunk);
    }

    const doneEvent = events[0] as DoneEvent;
    expect(doneEvent.reason).not.toBe("toolUse"); // Should remain original stop reason

    const content = doneEvent.message.content;
    const toolCalls = content.filter((p) => p.type === "toolCall");
    expect(toolCalls).toHaveLength(0); // None successfully parsed

    // Original malformed text MUST be preserved!
    const textPart = (content.find((p) => p.type === "text") as { type: string; text: string })
      .text;
    expect(textPart).toContain('Action: {"tool": "broken"');
  });

  it("should strip <think> even if the closing tag is missing", async () => {
    const fixtureText = await fs.readFile(
      path.join(FIXTURES_DIR, "unterminated-think.txt"),
      "utf-8",
    );
    const nativeStreamFn = createMockNativeStreamFn(fixtureText);
    const wrappedStreamFn = wrapStreamFnWithReActFallback(nativeStreamFn, {
      modelId: "deepseek-r1",
      providerId: "deepseek-r1",
      providerType: "lmstudio",
      toolFallback: "react",
    });

    const stream = await wrappedStreamFn(
      // eslint-disable-next-line no-explicit-any
      { id: "deepseek-r1", api: "test", provider: "lmstudio" } as unknown as any,
      // eslint-disable-next-line no-explicit-any
      { tools: [{ name: "get_weather", description: "testing" }] } as unknown as any,
      {},
    );
    const events: unknown[] = [];
    for await (const chunk of stream) {
      events.push(chunk);
    }

    const doneEvent = events[0] as DoneEvent;
    const content = doneEvent.message.content;

    const textPart =
      (content.find((p) => p.type === "text") as { type: string; text: string })?.text || "";
    // Because it's a reasoning model, everything inside the unterminated think MUST be stripped, up to the end of the string.
    expect(textPart).not.toContain("I forgot how to close my thinking block.");
    expect(textPart).toBe(""); // Entire text was swallowed by the greedy to-end match.

    const toolCall = content.find((p) => p.type === "toolCall");
    // We expect the tool call to be swallowed because it was inside an unterminated <think> block!
    expect(toolCall).toBeUndefined();
  });

  it("should ignore 'Action:' markers that are not at the start of a line", async () => {
    const mixedText = `
Here is an example of what NOT to do: You should not just write Action: {"tool": "fake", "args": {}}. 
Instead, you should always start a new line like this:
Action: {"tool": "real_tool", "args": {"param": 123}}
    `;
    const nativeStreamFn = createMockNativeStreamFn(mixedText);
    const wrappedStreamFn = wrapStreamFnWithReActFallback(nativeStreamFn, {
      modelId: "llama3",
      providerId: "llama3",
      providerType: "ollama",
      toolFallback: "react",
    });

    const stream = await wrappedStreamFn(
      // eslint-disable-next-line no-explicit-any
      { id: "llama3", api: "test", provider: "ollama" } as unknown as any,
      // eslint-disable-next-line no-explicit-any
      { tools: [{ name: "real_tool", description: "testing" }] } as unknown as any,
      {},
    );

    const events: Array<Record<string, unknown>> = [];
    for await (const chunk of stream) {
      events.push(chunk as Record<string, unknown>);
    }

    const doneEvent = events[0];
    const message = doneEvent.message as Record<string, unknown>;
    const content = message.content as Array<Record<string, unknown>>;

    const toolCalls = content.filter((p) => p.type === "toolCall");
    // Should ONLY find the real_tool, NOT the fake one
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("real_tool");

    const textPart = (content.find((p) => p.type === "text") as { type: string; text: string })
      .text;
    expect(textPart).toContain('You should not just write Action: {"tool": "fake", "args": {}}');
    expect(textPart).not.toContain('Action: {"tool": "real_tool"');
  });

  it("should default to 'auto' when toolFallback is undefined and use heuristics", async () => {
    // phi-2 is known to have no native tools according to discovery.ts
    const nativeStreamFn = createMockNativeStreamFn('Action: {"tool": "phi_tool", "args": {}}');
    const wrappedStreamFn = wrapStreamFnWithReActFallback(nativeStreamFn, {
      modelId: "phi-2",
      providerId: "phi-2",
      providerType: "ollama",
      // toolFallback: undefined // Default
    });

    const stream = await wrappedStreamFn(
      // eslint-disable-next-line no-explicit-any
      { id: "phi-2", api: "test", provider: "ollama" } as unknown as any,
      // eslint-disable-next-line no-explicit-any
      { tools: [{ name: "phi_tool", description: "testing" }] } as unknown as any,
      {},
    );

    const events: Array<Record<string, unknown>> = [];
    for await (const chunk of stream) {
      events.push(chunk as Record<string, unknown>);
    }

    const doneEvent = events[0];
    const message = doneEvent.message as Record<string, unknown>;
    const content = message.content as Array<Record<string, unknown>>;

    const toolCalls = content.filter((p) => p.type === "toolCall");
    // Should trigger fallback because of heuristic
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("phi_tool");
  });

  it("should respect cached 'native' status in 'auto' mode even if heuristics say 'none'", async () => {
    // 1. Setup cache with 'native' status for an Ollama model
    const providerId = "learned-native-provider";
    const modelId = "ollama-model";
    await updateModelCapability(configDir, providerId, modelId, "native");

    // 2. Mock native stream that returns a REAL tool call (simulating a model that actually supports it)
    const nativeStreamFn = async () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", name: "native_tool", id: "call_1", args: {} }],
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        stream.end();
      });
      return stream;
    };

    const wrappedStreamFn = wrapStreamFnWithReActFallback(nativeStreamFn, {
      modelId,
      providerId,
      providerType: "ollama", // Heuristically this would be toolFormat: 'none'
      configDir,
      toolFallback: "auto",
    });

    const stream = await wrappedStreamFn(
      // eslint-disable-next-line no-explicit-any
      { id: modelId, api: "test", provider: "ollama" } as unknown as any,
      // eslint-disable-next-line no-explicit-any
      { tools: [{ name: "native_tool", description: "testing" }] } as unknown as any,
      {},
    );

    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doneChunk = chunks.find((c: unknown) => (c as any).type === "done");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolCalls = (doneChunk as any).message.content.filter((p: any) => p.type === "toolCall");

    // Expectation: It used the NATIVE path (native_tool) because the cache said 'native',
    // overriding the 'ollama' -> 'none' heuristic.
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("native_tool");
  });

  it("should NOT treat 'Action:' as a tool call if tools are not provided", async () => {
    const textWithAction = 'I will help you. Action: {"tool": "phi_tool", "args": {}}';
    const nativeStreamFn = createMockNativeStreamFn(textWithAction);
    const wrappedStreamFn = wrapStreamFnWithReActFallback(nativeStreamFn, {
      modelId: "phi-2",
      providerId: "phi-2",
      providerType: "ollama",
      toolFallback: "react",
    });

    const stream = await wrappedStreamFn(
      // eslint-disable-next-line no-explicit-any
      { id: "phi-2", api: "test", provider: "ollama" } as unknown as any,
      // NO TOOLS PROVIDED
      // eslint-disable-next-line no-explicit-any
      { tools: [] } as unknown as any,
      {},
    );

    const events: Array<Record<string, unknown>> = [];
    for await (const chunk of stream) {
      events.push(chunk as Record<string, unknown>);
    }

    const doneEvent = events[0];
    const message = doneEvent.message as Record<string, unknown>;
    const content = message.content as Array<Record<string, unknown>>;

    const toolCalls = content.filter((p) => p.type === "toolCall");
    // Should NOT find any tool calls because tools were empty
    expect(toolCalls).toHaveLength(0);

    const textPart = (content.find((p) => p.type === "text") as { type: string; text: string })
      .text;
    expect(textPart).toBe(textWithAction);
  });
});
