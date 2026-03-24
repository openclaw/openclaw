import fs from "node:fs/promises";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { wrapStreamFnWithReActFallback } from "./react-fallback-stream.js";

const FIXTURES_DIR = path.resolve(__dirname, "../../../test-fixtures/streams/local-models");

/**
 * Creates a mock StreamFn that perfectly mimics how OpenClaw native providers (Ollama/LMStudio)
 * return a stream when the model has finished generating text.
 */
function createMockNativeStreamFn(mockOutputText: string): StreamFn {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    
    // Simulate async network delay
    setTimeout(() => {
      stream.push({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: mockOutputText }],
          stopReason: "stop"
        } as any
      });
      stream.end();
    }, 10);
    
    return stream;
  };
}

describe("ReAct Fallback Stream E2E Integration", () => {

  it("should process LMStudio Qwen/DeepSeek reasoning streams and extract valid ToolCalls while stripping <think>", async () => {
    const fixtureText = await fs.readFile(path.join(FIXTURES_DIR, "qwen3-lmstudio-think.txt"), "utf-8");
    
    const nativeStreamFn = createMockNativeStreamFn(fixtureText);
    const wrappedStreamFn = wrapStreamFnWithReActFallback(nativeStreamFn, {
      modelId: "deepseek-r1",
      providerType: "lmstudio",
      toolFallback: "react"
    });

    const stream = await wrappedStreamFn({ id: "deepseek-r1", api: "test", provider: "lmstudio" } as any, { tools: [{ name: "get_weather", description: "testing" }] } as any, {});
    
    const events: any[] = [];
    for await (const chunk of stream) {
      events.push(chunk);
    }

    expect(events).toHaveLength(1);
    const doneEvent = events[0];
    
    expect(doneEvent.type).toBe("done");
    expect(doneEvent.reason).toBe("toolUse"); // Successfully intercepted and upgraded reason
    
    const content = doneEvent.message.content;
    expect(content).toBeInstanceOf(Array);
    
    // The `<think>` tags MUST be gone
    const textPart = content.find((p: any) => p.type === "text");
    expect(textPart).toBeDefined();
    expect(textPart.text).not.toContain("<think>");
    expect(textPart.text).toContain("Here is my internal reasoning."); // text after think tag

    // The ToolCall MUST be present
    const toolCallPart = content.find((p: any) => p.type === "toolCall");
    expect(toolCallPart).toBeDefined();
    expect(toolCallPart.name).toBe("get_weather");
    expect(toolCallPart.arguments).toEqual({ location: "San Francisco, CA" });
  });

  it("should process Ollama LLaMA3 React streams and extract valid Action calls", async () => {
    const fixtureText = await fs.readFile(path.join(FIXTURES_DIR, "llama3-react-action.txt"), "utf-8");
    
    const nativeStreamFn = createMockNativeStreamFn(fixtureText);
    const wrappedStreamFn = wrapStreamFnWithReActFallback(nativeStreamFn, {
      modelId: "llama3",
      providerType: "ollama",
      toolFallback: "react"
    });

    const stream = await wrappedStreamFn({ id: "llama3", api: "test", provider: "ollama" } as any, { tools: [{ name: "codebase_search", description: "testing" }] } as any, {});
    
    const events: any[] = [];
    for await (const chunk of stream) {
      events.push(chunk);
    }

    expect(events).toHaveLength(1);
    const doneEvent = events[0];
    
    expect(doneEvent.type).toBe("done");
    expect(doneEvent.reason).toBe("toolUse");
    
    const content = doneEvent.message.content;
    const textPart = content.find((p: any) => p.type === "text");
    expect(textPart.text).toContain("Thought: The user is asking");
    expect(textPart.text).toContain("I will wait for the result");
    expect(textPart.text).not.toContain("Action: {");

    const toolCallPart = content.find((p: any) => p.type === "toolCall");
    expect(toolCallPart).toBeDefined();
    expect(toolCallPart.name).toBe("codebase_search");
    expect(toolCallPart.arguments).toEqual({ query: "auth" });
  });

  it("should bypass fallback safely if model has native capabilities and toolFallback is auto", async () => {
    // Modify model ID to simulate a native-capable model according to REAL heuristics (e.g. qwen2-coder)
    const nativeStreamFn = createMockNativeStreamFn("Native Output Here");
    const wrappedStreamFn = wrapStreamFnWithReActFallback(nativeStreamFn, {
      modelId: "qwen2-coder",
      providerType: "openai-compatible",
      toolFallback: "auto" // Auto delegates to discovery
    });

    const stream = await wrappedStreamFn({ id: "qwen2-coder", api: "test" } as any, { tools: [{ name: "native_tool", description: "test" }] } as any, {});
    
    const events: any[] = [];
    for await (const chunk of stream) {
      events.push(chunk);
    }

    const content = events[0].message.content;
    expect(content[0].text).toBe("Native Output Here");
    expect(events[0].reason).toBe("stop");
  });

  it("should handle multiple consecutive tool calls", async () => {
    const fixtureText = await fs.readFile(path.join(FIXTURES_DIR, "multiple-actions.txt"), "utf-8");
    const nativeStreamFn = createMockNativeStreamFn(fixtureText);
    const wrappedStreamFn = wrapStreamFnWithReActFallback(nativeStreamFn, {
      modelId: "llama3",
      providerType: "ollama",
      toolFallback: "react"
    });

    const stream = await wrappedStreamFn({ id: "llama3", api: "test", provider: "ollama" } as any, { tools: [{ name: "get_weather", description: "testing" }, { name: "get_time", description: "testing" }] } as any, {});
    const events: any[] = [];
    for await (const chunk of stream) events.push(chunk);

    const doneEvent = events[0];
    const content = doneEvent.message.content;
    const toolCalls = content.filter((p: any) => p.type === "toolCall");
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].name).toBe("get_weather");
    expect(toolCalls[1].name).toBe("get_time");
    
    // Check text retention
    const textPart = content.find((p: any) => p.type === "text").text;
    expect(textPart).toContain("Thought: I need to check both weather and time.");
    expect(textPart).toContain("I'll wait for the data.");
  });

  it("should cleanly ignore and return malformed JSON as text", async () => {
    const fixtureText = await fs.readFile(path.join(FIXTURES_DIR, "malformed-json.txt"), "utf-8");
    const nativeStreamFn = createMockNativeStreamFn(fixtureText);
    const wrappedStreamFn = wrapStreamFnWithReActFallback(nativeStreamFn, {
      modelId: "llama3",
      providerType: "ollama",
      toolFallback: "react"
    });

    const stream = await wrappedStreamFn({ id: "llama3", api: "test", provider: "ollama" } as any, { tools: [{ name: "broken", description: "testing" }] } as any, {});
    const events: any[] = [];
    for await (const chunk of stream) events.push(chunk);

    const doneEvent = events[0];
    expect(doneEvent.reason).not.toBe("toolUse"); // Should remain original stop reason
    
    const content = doneEvent.message.content;
    const toolCalls = content.filter((p: any) => p.type === "toolCall");
    expect(toolCalls).toHaveLength(0); // None successfully parsed
    
    // Original malformed text MUST be preserved!
    const textPart = content.find((p: any) => p.type === "text").text;
    expect(textPart).toContain("Action: {\"tool\": \"broken\"");
  });

  it("should strip <think> even if the closing tag is missing", async () => {
    const fixtureText = await fs.readFile(path.join(FIXTURES_DIR, "unterminated-think.txt"), "utf-8");
    const nativeStreamFn = createMockNativeStreamFn(fixtureText);
    const wrappedStreamFn = wrapStreamFnWithReActFallback(nativeStreamFn, {
      modelId: "deepseek-r1",
      providerType: "lmstudio",
      toolFallback: "react"
    });

    const stream = await wrappedStreamFn({ id: "deepseek-r1", api: "test", provider: "lmstudio" } as any, { tools: [{ name: "get_weather", description: "testing" }] } as any, {});
    const events: any[] = [];
    for await (const chunk of stream) events.push(chunk);

    const content = events[0].message.content;
    const textPart = content.find((p: any) => p.type === "text")?.text || "";
    // Because it's a reasoning model, everything inside the unterminated think MUST be stripped, up to the end of the string.
    expect(textPart).not.toContain("I forgot how to close my thinking block.");
    expect(textPart).toBe(""); // Entire text was swallowed by the greedy to-end match.

    const toolCall = content.find((p: any) => p.type === "toolCall");
    // We expect the tool call to be swallowed because it was inside an unterminated <think> block!
    expect(toolCall).toBeUndefined();
  });

});
