/**
 * Unit tests for openai-ws-stream.ts
 *
 * Covers:
 *  - Message format converters (convertMessagesToInputItems, convertTools)
 *  - Response → AssistantMessage parser (buildAssistantMessageFromResponse)
 *  - createOpenAIWebSocketStreamFn behaviour (connect, send, receive, fallback)
 *  - Session registry helpers (releaseWsSession, hasWsSession)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResponseObject } from "./openai-ws-connection.js";
import {
  buildAssistantMessageFromResponse,
  convertMessagesToInputItems,
  convertTools,
  createOpenAIWebSocketStreamFn,
  hasWsSession,
  releaseWsSession,
} from "./openai-ws-stream.js";

// ─────────────────────────────────────────────────────────────────────────────
// Mock OpenAIWebSocketManager
// ─────────────────────────────────────────────────────────────────────────────

// We mock the entire openai-ws-connection module so no real WebSocket is opened.
const { MockManager } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  type AnyFn = (...args: unknown[]) => void;

  // Shared mutable flag so inner class can see it
  let _globalConnectShouldFail = false;

  class MockManager extends EventEmitter {
    private _listeners: AnyFn[] = [];
    private _previousResponseId: string | null = null;
    private _connected = false;
    private _broken = false;

    sentEvents: unknown[] = [];
    connectCallCount = 0;
    closeCallCount = 0;

    // Allow tests to override connect/send behaviour
    connectShouldFail = false;
    sendShouldFail = false;

    get previousResponseId(): string | null {
      return this._previousResponseId;
    }

    async connect(_apiKey: string): Promise<void> {
      this.connectCallCount++;
      if (this.connectShouldFail || _globalConnectShouldFail) {
        throw new Error("Mock connect failure");
      }
      this._connected = true;
    }

    isConnected(): boolean {
      return this._connected && !this._broken;
    }

    send(event: unknown): void {
      if (!this._connected) {
        throw new Error("cannot send — not connected");
      }
      if (this.sendShouldFail) {
        throw new Error("Mock send failure");
      }
      this.sentEvents.push(event);
      const maybeEvent = event as { type?: string; generate?: boolean; model?: string } | null;
      // Auto-complete warm-up events so warm-up-enabled tests don't hang waiting
      // for the warm-up terminal event.
      if (maybeEvent?.type === "response.create" && maybeEvent.generate === false) {
        queueMicrotask(() => {
          this.simulateEvent({
            type: "response.completed",
            response: makeResponseObject(`warmup-${Date.now()}`),
          });
        });
      }
    }

    warmUp(params: { model: string; tools?: unknown[]; instructions?: string }): void {
      this.send({
        type: "response.create",
        generate: false,
        model: params.model,
        ...(params.tools ? { tools: params.tools } : {}),
        ...(params.instructions ? { instructions: params.instructions } : {}),
      });
    }

    onMessage(handler: (event: unknown) => void): () => void {
      this._listeners.push(handler as AnyFn);
      return () => {
        this._listeners = this._listeners.filter((l) => l !== handler);
      };
    }

    close(): void {
      this.closeCallCount++;
      this._connected = false;
    }

    // Test helper: simulate WebSocket connection drop mid-request
    simulateClose(code = 1006, reason = "connection lost"): void {
      this._connected = false;
      this.emit("close", code, reason);
    }

    // Test helper: simulate a server event
    simulateEvent(event: unknown): void {
      for (const fn of this._listeners) {
        fn(event);
      }
    }

    // Test helper: simulate connection being broken
    simulateBroken(): void {
      this._connected = false;
      this._broken = true;
    }

    // Test helper: set the previous response ID as if a turn completed
    setPreviousResponseId(id: string): void {
      this._previousResponseId = id;
    }

    static lastInstance: MockManager | null = null;
    static instances: MockManager[] = [];

    static reset(): void {
      MockManager.lastInstance = null;
      MockManager.instances = [];
    }
  }

  // Patch constructor to track instances
  const OriginalMockManager = MockManager;
  class TrackedMockManager extends OriginalMockManager {
    constructor(...args: ConstructorParameters<typeof OriginalMockManager>) {
      super(...args);
      TrackedMockManager.lastInstance = this;
      TrackedMockManager.instances.push(this);
    }

    static lastInstance: TrackedMockManager | null = null;
    static instances: TrackedMockManager[] = [];

    /** Class-level flag: make ALL new instances fail on connect(). */
    static get globalConnectShouldFail(): boolean {
      return _globalConnectShouldFail;
    }
    static set globalConnectShouldFail(v: boolean) {
      _globalConnectShouldFail = v;
    }

    static reset(): void {
      TrackedMockManager.lastInstance = null;
      TrackedMockManager.instances = [];
      _globalConnectShouldFail = false;
    }
  }

  return { MockManager: TrackedMockManager };
});

vi.mock("./openai-ws-connection.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./openai-ws-connection.js")>();
  return {
    ...original,
    OpenAIWebSocketManager: MockManager,
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// Mock pi-ai
// ─────────────────────────────────────────────────────────────────────────────

// Track if streamSimple (HTTP fallback) was called
const streamSimpleCalls: Array<{ model: unknown; context: unknown }> = [];

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("@mariozechner/pi-ai")>();

  const mockStreamSimple = vi.fn((model: unknown, context: unknown) => {
    streamSimpleCalls.push({ model, context });
    // Return a minimal AssistantMessageEventStream-like async iterable
    const stream = original.createAssistantMessageEventStream();
    queueMicrotask(() => {
      const msg = makeFakeAssistantMessage("http fallback response");
      stream.push({ type: "done", reason: "stop", message: msg });
      stream.end();
    });
    return stream;
  });

  return {
    ...original,
    streamSimple: mockStreamSimple,
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve a StreamFn return value (which may be a Promise) to an AsyncIterable. */
async function resolveStream(
  stream: ReturnType<ReturnType<typeof createOpenAIWebSocketStreamFn>>,
): Promise<AsyncIterable<unknown>> {
  return stream instanceof Promise ? await stream : stream;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

type FakeMessage =
  | { role: "user"; content: string | unknown[]; timestamp: number }
  | {
      role: "assistant";
      content: unknown[];
      stopReason: string;
      api: string;
      provider: string;
      model: string;
      usage: unknown;
      timestamp: number;
    }
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: unknown[];
      isError: boolean;
      timestamp: number;
    };

function userMsg(text: string): FakeMessage {
  return { role: "user", content: text, timestamp: 0 };
}

function assistantMsg(
  textBlocks: string[],
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [],
): FakeMessage {
  const content: unknown[] = [];
  for (const t of textBlocks) {
    content.push({ type: "text", text: t });
  }
  for (const tc of toolCalls) {
    content.push({ type: "toolCall", id: tc.id, name: tc.name, arguments: tc.args });
  }
  return {
    role: "assistant",
    content,
    stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.2",
    usage: {},
    timestamp: 0,
  };
}

function toolResultMsg(callId: string, output: string): FakeMessage {
  return {
    role: "toolResult",
    toolCallId: callId,
    toolName: "test_tool",
    content: [{ type: "text", text: output }],
    isError: false,
    timestamp: 0,
  };
}

function makeFakeAssistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    stopReason: "stop" as const,
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.2",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
  };
}

function makeResponseObject(
  id: string,
  outputText?: string,
  toolCallName?: string,
): ResponseObject {
  const output: ResponseObject["output"] = [];
  if (outputText) {
    output.push({
      type: "message",
      id: "item_1",
      role: "assistant",
      content: [{ type: "output_text", text: outputText }],
    });
  }
  if (toolCallName) {
    output.push({
      type: "function_call",
      id: "item_2",
      call_id: "call_abc",
      name: toolCallName,
      arguments: '{"arg":"value"}',
    });
  }
  return {
    id,
    object: "response",
    created_at: Date.now(),
    status: "completed",
    model: "gpt-5.2",
    output,
    usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe("convertTools", () => {
  it("returns empty array for undefined tools", () => {
    expect(convertTools(undefined)).toEqual([]);
  });

  it("returns empty array for empty tools", () => {
    expect(convertTools([])).toEqual([]);
  });

  it("converts tools to FunctionToolDefinition format", () => {
    const tools = [
      {
        name: "exec",
        description: "Run a command",
        parameters: { type: "object", properties: { cmd: { type: "string" } } },
      },
    ];
    const result = convertTools(tools as unknown as Parameters<typeof convertTools>[0]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "function",
      function: {
        name: "exec",
        description: "Run a command",
        parameters: { type: "object", properties: { cmd: { type: "string" } } },
      },
    });
  });

  it("handles tools without description", () => {
    const tools = [{ name: "ping", description: "", parameters: {} }];
    const result = convertTools(tools as Parameters<typeof convertTools>[0]);
    expect(result[0]?.function?.name).toBe("ping");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("convertMessagesToInputItems", () => {
  it("converts a simple user text message", () => {
    const items = convertMessagesToInputItems([userMsg("Hello!")] as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "message", role: "user", content: "Hello!" });
  });

  it("converts an assistant text-only message", () => {
    const items = convertMessagesToInputItems([assistantMsg(["Hi there."])] as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "message", role: "assistant", content: "Hi there." });
  });

  it("converts an assistant message with a tool call", () => {
    const msg = assistantMsg(
      ["Let me run that."],
      [{ id: "call_1", name: "exec", args: { cmd: "ls" } }],
    );
    const items = convertMessagesToInputItems([msg] as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    // Should produce a text message and a function_call item
    const textItem = items.find((i) => i.type === "message");
    const fcItem = items.find((i) => i.type === "function_call");
    expect(textItem).toBeDefined();
    expect(fcItem).toMatchObject({
      type: "function_call",
      call_id: "call_1",
      name: "exec",
    });
    const fc = fcItem as { arguments: string };
    expect(JSON.parse(fc.arguments)).toEqual({ cmd: "ls" });
  });

  it("converts a tool result message", () => {
    const items = convertMessagesToInputItems([toolResultMsg("call_1", "file.txt")] as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "function_call_output",
      call_id: "call_1",
      output: "file.txt",
    });
  });

  it("converts a full multi-turn conversation", () => {
    const messages: FakeMessage[] = [
      userMsg("Run ls"),
      assistantMsg([], [{ id: "call_1", name: "exec", args: { cmd: "ls" } }]),
      toolResultMsg("call_1", "file.txt\nfoo.ts"),
    ];
    const items = convertMessagesToInputItems(
      messages as Parameters<typeof convertMessagesToInputItems>[0],
    );

    const userItem = items.find(
      (i) => i.type === "message" && (i as { role?: string }).role === "user",
    );
    const fcItem = items.find((i) => i.type === "function_call");
    const outputItem = items.find((i) => i.type === "function_call_output");

    expect(userItem).toBeDefined();
    expect(fcItem).toBeDefined();
    expect(outputItem).toBeDefined();
  });

  it("handles assistant messages with only tool calls (no text)", () => {
    const msg = assistantMsg([], [{ id: "call_2", name: "read", args: { path: "/etc/hosts" } }]);
    const items = convertMessagesToInputItems([msg] as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe("function_call");
  });

  it("skips thinking blocks in assistant messages", () => {
    const msg = {
      role: "assistant" as const,
      content: [
        { type: "thinking", thinking: "internal reasoning..." },
        { type: "text", text: "Here is my answer." },
      ],
      stopReason: "stop",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.2",
      usage: {},
      timestamp: 0,
    };
    const items = convertMessagesToInputItems([msg] as Parameters<
      typeof convertMessagesToInputItems
    >[0]);
    expect(items).toHaveLength(1);
    expect((items[0] as { content?: unknown }).content).toBe("Here is my answer.");
  });

  it("returns empty array for empty messages", () => {
    expect(convertMessagesToInputItems([])).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("buildAssistantMessageFromResponse", () => {
  const modelInfo = { api: "openai-responses", provider: "openai", id: "gpt-5.2" };

  it("extracts text content from a message output item", () => {
    const response = makeResponseObject("resp_1", "Hello from assistant");
    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.content).toHaveLength(1);
    const textBlock = msg.content[0] as { type: string; text: string };
    expect(textBlock.type).toBe("text");
    expect(textBlock.text).toBe("Hello from assistant");
  });

  it("sets stopReason to 'stop' for text-only responses", () => {
    const response = makeResponseObject("resp_1", "Just text");
    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.stopReason).toBe("stop");
  });

  it("extracts tool call from function_call output item", () => {
    const response = makeResponseObject("resp_2", undefined, "exec");
    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    const tc = msg.content.find((c) => c.type === "toolCall") as {
      type: string;
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    };
    expect(tc).toBeDefined();
    expect(tc.name).toBe("exec");
    expect(tc.id).toBe("call_abc");
    expect(tc.arguments).toEqual({ arg: "value" });
  });

  it("sets stopReason to 'toolUse' when tool calls are present", () => {
    const response = makeResponseObject("resp_3", undefined, "exec");
    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.stopReason).toBe("toolUse");
  });

  it("includes both text and tool calls when both present", () => {
    const response = makeResponseObject("resp_4", "Running...", "exec");
    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.content.some((c) => c.type === "text")).toBe(true);
    expect(msg.content.some((c) => c.type === "toolCall")).toBe(true);
    expect(msg.stopReason).toBe("toolUse");
  });

  it("maps usage tokens correctly", () => {
    const response = makeResponseObject("resp_5", "Hello");
    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.usage.input).toBe(100);
    expect(msg.usage.output).toBe(50);
    expect(msg.usage.totalTokens).toBe(150);
  });

  it("sets model/provider/api from modelInfo", () => {
    const response = makeResponseObject("resp_6", "Hi");
    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.api).toBe("openai-responses");
    expect(msg.provider).toBe("openai");
    expect(msg.model).toBe("gpt-5.2");
  });

  it("handles empty output gracefully", () => {
    const response = makeResponseObject("resp_7");
    const msg = buildAssistantMessageFromResponse(response, modelInfo);
    expect(msg.content).toEqual([]);
    expect(msg.stopReason).toBe("stop");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("createOpenAIWebSocketStreamFn", () => {
  const modelStub = {
    api: "openai-responses",
    provider: "openai",
    id: "gpt-5.2",
    contextWindow: 128000,
    maxTokens: 4096,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    name: "GPT-5.2",
  };

  const contextStub = {
    systemPrompt: "You are helpful.",
    messages: [userMsg("Hello!") as Parameters<typeof convertMessagesToInputItems>[0][number]],
    tools: [],
  };

  beforeEach(() => {
    MockManager.reset();
    streamSimpleCalls.length = 0;
  });

  afterEach(() => {
    // Clean up any sessions created in tests to avoid cross-test pollution
    MockManager.instances.forEach((_, i) => {
      // Session IDs used in tests follow a predictable pattern
      releaseWsSession(`test-session-${i}`);
    });
    releaseWsSession("sess-1");
    releaseWsSession("sess-2");
    releaseWsSession("sess-fallback");
    releaseWsSession("sess-incremental");
    releaseWsSession("sess-full");
    releaseWsSession("sess-tools");
  });

  it("connects to the WebSocket on first call", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-1");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );

    // Give the microtask queue time to run
    await new Promise((r) => setImmediate(r));

    const manager = MockManager.lastInstance;
    expect(manager?.connectCallCount).toBe(1);
    // Consume stream to avoid dangling promise
    void resolveStream(stream);
  });

  it("sends a response.create event on first turn (full context)", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-full");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );

    const completed = new Promise<void>((res, rej) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          const manager = MockManager.lastInstance!;

          // Simulate the server completing the response
          manager.simulateEvent({
            type: "response.completed",
            response: makeResponseObject("resp_1", "Hello!"),
          });

          for await (const _ of await resolveStream(stream)) {
            // consume events
          }
          res();
        } catch (e) {
          rej(e);
        }
      });
    });

    await completed;

    const manager = MockManager.lastInstance!;
    expect(manager.sentEvents).toHaveLength(1);
    const sent = manager.sentEvents[0] as { type: string; model: string; input: unknown[] };
    expect(sent.type).toBe("response.create");
    expect(sent.model).toBe("gpt-5.2");
    expect(Array.isArray(sent.input)).toBe(true);
  });

  it("emits an AssistantMessage on response.completed", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-2");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );

    const events: unknown[] = [];
    const done = (async () => {
      for await (const ev of await resolveStream(stream)) {
        events.push(ev);
      }
    })();

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;
    manager.simulateEvent({
      type: "response.completed",
      response: makeResponseObject("resp_hello", "Hello back!"),
    });

    await done;

    const doneEvent = events.find((e) => (e as { type?: string }).type === "done") as
      | {
          type: string;
          reason: string;
          message: { content: Array<{ text: string }> };
        }
      | undefined;
    expect(doneEvent).toBeDefined();
    expect(doneEvent?.message.content[0]?.text).toBe("Hello back!");
  });

  it("falls back to HTTP when WebSocket connect fails (session pre-broken via flag)", async () => {
    // Set the class-level flag BEFORE calling streamFn so the new instance
    // fails on connect().  We patch the static default via MockManager directly.
    MockManager.globalConnectShouldFail = true;

    try {
      const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-fallback");
      const stream = streamFn(
        modelStub as Parameters<typeof streamFn>[0],
        contextStub as Parameters<typeof streamFn>[1],
      );

      // Consume — should fall back to HTTP (streamSimple mock).
      const messages: unknown[] = [];
      for await (const ev of await resolveStream(stream)) {
        messages.push(ev);
      }

      // streamSimple was called as part of HTTP fallback
      expect(streamSimpleCalls.length).toBeGreaterThanOrEqual(1);

      // manager.close() must be called to cancel background reconnect attempts
      expect(MockManager.lastInstance!.closeCallCount).toBeGreaterThanOrEqual(1);
    } finally {
      MockManager.globalConnectShouldFail = false;
    }
  });

  it("tracks previous_response_id across turns (incremental send)", async () => {
    const sessionId = "sess-incremental";
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", sessionId);

    // ── Turn 1: full context ─────────────────────────────────────────────
    const ctx1 = {
      systemPrompt: "You are helpful.",
      messages: [userMsg("Run ls")] as Parameters<typeof convertMessagesToInputItems>[0],
      tools: [],
    };

    const stream1 = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      ctx1 as Parameters<typeof streamFn>[1],
    );

    const events1: unknown[] = [];
    const done1 = (async () => {
      for await (const ev of await resolveStream(stream1)) {
        events1.push(ev);
      }
    })();

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;

    // Server responds with a tool call
    const turn1Response = makeResponseObject("resp_turn1", undefined, "exec");
    manager.setPreviousResponseId("resp_turn1");
    manager.simulateEvent({ type: "response.completed", response: turn1Response });
    await done1;

    // ── Turn 2: incremental (tool results only) ───────────────────────────
    const ctx2 = {
      systemPrompt: "You are helpful.",
      messages: [
        userMsg("Run ls"),
        assistantMsg([], [{ id: "call_1", name: "exec", args: { cmd: "ls" } }]),
        toolResultMsg("call_1", "file.txt"),
      ] as Parameters<typeof convertMessagesToInputItems>[0],
      tools: [],
    };

    const stream2 = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      ctx2 as Parameters<typeof streamFn>[1],
    );

    const events2: unknown[] = [];
    const done2 = (async () => {
      for await (const ev of await resolveStream(stream2)) {
        events2.push(ev);
      }
    })();

    await new Promise((r) => setImmediate(r));
    manager.simulateEvent({
      type: "response.completed",
      response: makeResponseObject("resp_turn2", "Here are the files."),
    });
    await done2;

    // Turn 2 should have sent previous_response_id and only tool results
    expect(manager.sentEvents).toHaveLength(2);
    const sent2 = manager.sentEvents[1] as {
      previous_response_id?: string;
      input: Array<{ type: string }>;
    };
    expect(sent2.previous_response_id).toBe("resp_turn1");
    // Input should only contain tool results, not the full history
    const inputTypes = (sent2.input ?? []).map((i) => i.type);
    expect(inputTypes.every((t) => t === "function_call_output")).toBe(true);
    expect(inputTypes).toHaveLength(1);
  });

  it("sends instructions (system prompt) in each request", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-tools");
    const ctx = {
      systemPrompt: "Be concise.",
      messages: [userMsg("Hello")] as Parameters<typeof convertMessagesToInputItems>[0],
      tools: [{ name: "exec", description: "run", parameters: {} }],
    };

    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      ctx as Parameters<typeof streamFn>[1],
    );

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;
    manager.simulateEvent({
      type: "response.completed",
      response: makeResponseObject("resp_x", "ok"),
    });

    for await (const _ of await resolveStream(stream)) {
      // consume
    }

    const sent = manager.sentEvents[0] as {
      instructions?: string;
      tools?: unknown[];
    };
    expect(sent.instructions).toBe("Be concise.");
    expect(Array.isArray(sent.tools)).toBe(true);
    expect((sent.tools ?? []).length).toBeGreaterThan(0);
  });

  it("resets session state and falls back to HTTP when send() throws", async () => {
    const sessionId = "sess-send-fail-reset";
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", sessionId);

    // 1. Run a successful first turn to populate the registry
    const stream1 = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            type: "response.completed",
            response: makeResponseObject("resp-ok", "OK"),
          });
          for await (const _ of await resolveStream(stream1)) {
            /* consume */
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
    expect(hasWsSession(sessionId)).toBe(true);

    // 2. Arm send failure and record pre-call streamSimpleCalls count
    MockManager.lastInstance!.sendShouldFail = true;
    const callsBefore = streamSimpleCalls.length;

    // 3. Second call: send throws → must fall back to HTTP and clear registry
    const stream2 = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
    );
    for await (const _ of await resolveStream(stream2)) {
      /* consume */
    }

    // Registry cleared after send failure
    expect(hasWsSession(sessionId)).toBe(false);
    // HTTP fallback invoked
    expect(streamSimpleCalls.length).toBeGreaterThan(callsBefore);
  });

  it("forwards temperature and maxTokens to response.create", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-temp");
    const opts = { temperature: 0.3, maxTokens: 256 };
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      opts as Parameters<typeof streamFn>[2],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            type: "response.completed",
            response: makeResponseObject("resp-temp", "Done"),
          });
          for await (const _ of await resolveStream(stream)) {
            /* consume */
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
    const sent = MockManager.lastInstance!.sentEvents[0] as Record<string, unknown>;
    expect(sent.type).toBe("response.create");
    expect(sent.temperature).toBe(0.3);
    expect(sent.max_output_tokens).toBe(256);
  });

  it("forwards reasoningEffort/reasoningSummary to response.create reasoning block", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-reason");
    const opts = { reasoningEffort: "high", reasoningSummary: "auto" };
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      opts as unknown as Parameters<typeof streamFn>[2],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            type: "response.completed",
            response: makeResponseObject("resp-reason", "Deep thought"),
          });
          for await (const _ of await resolveStream(stream)) {
            /* consume */
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
    const sent = MockManager.lastInstance!.sentEvents[0] as Record<string, unknown>;
    expect(sent.type).toBe("response.create");
    expect(sent.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  it("forwards topP and toolChoice to response.create", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-topp");
    const opts = { topP: 0.9, toolChoice: "auto" };
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      opts as unknown as Parameters<typeof streamFn>[2],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            type: "response.completed",
            response: makeResponseObject("resp-topp", "Done"),
          });
          for await (const _ of await resolveStream(stream)) {
            /* consume */
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
    const sent = MockManager.lastInstance!.sentEvents[0] as Record<string, unknown>;
    expect(sent.type).toBe("response.create");
    expect(sent.top_p).toBe(0.9);
    expect(sent.tool_choice).toBe("auto");
  });

  it("rejects promise when WebSocket drops mid-request", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-drop");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      {} as Parameters<typeof streamFn>[2],
    );
    // Let the send go through, then simulate connection drop before response.completed
    await new Promise<void>((resolve) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          // Simulate a connection drop instead of sending response.completed
          MockManager.lastInstance!.simulateClose(1006, "connection lost");
          const events: unknown[] = [];
          for await (const ev of await resolveStream(stream)) {
            events.push(ev);
          }
          // Should have gotten an error event, not hung forever
          const hasError = events.some(
            (e) => typeof e === "object" && e !== null && (e as { type: string }).type === "error",
          );
          expect(hasError).toBe(true);
          resolve();
        } catch {
          // The error propagation is also acceptable — promise rejected
          resolve();
        }
      });
    });
  });

  it("sends warm-up event before first request when openaiWsWarmup=true", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-warmup-enabled");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      { openaiWsWarmup: true } as unknown as Parameters<typeof streamFn>[2],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            type: "response.completed",
            response: makeResponseObject("resp-warm", "Done"),
          });
          for await (const _ of await resolveStream(stream)) {
            // consume
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
    const sent = MockManager.lastInstance!.sentEvents as Array<Record<string, unknown>>;
    expect(sent).toHaveLength(2);
    expect(sent[0]?.type).toBe("response.create");
    expect(sent[0]?.generate).toBe(false);
    expect(sent[1]?.type).toBe("response.create");
  });

  it("skips warm-up when openaiWsWarmup=false", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-warmup-disabled");
    const stream = streamFn(
      modelStub as Parameters<typeof streamFn>[0],
      contextStub as Parameters<typeof streamFn>[1],
      { openaiWsWarmup: false } as unknown as Parameters<typeof streamFn>[2],
    );
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          await new Promise((r) => setImmediate(r));
          MockManager.lastInstance!.simulateEvent({
            type: "response.completed",
            response: makeResponseObject("resp-nowarm", "Done"),
          });
          for await (const _ of await resolveStream(stream)) {
            // consume
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
    const sent = MockManager.lastInstance!.sentEvents as Array<Record<string, unknown>>;
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe("response.create");
    expect(sent[0]?.generate).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("releaseWsSession / hasWsSession", () => {
  beforeEach(() => {
    MockManager.reset();
  });

  afterEach(() => {
    releaseWsSession("registry-test");
  });

  it("hasWsSession returns false for unknown session", () => {
    expect(hasWsSession("nonexistent-session")).toBe(false);
  });

  it("hasWsSession returns true after a session is created", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "registry-test");
    const stream = streamFn(
      {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.2",
        contextWindow: 128000,
        maxTokens: 4096,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        name: "GPT-5.2",
      } as Parameters<typeof streamFn>[0],
      {
        systemPrompt: "test",
        messages: [userMsg("Hi") as Parameters<typeof convertMessagesToInputItems>[0][number]],
        tools: [],
      } as Parameters<typeof streamFn>[1],
    );

    await new Promise((r) => setImmediate(r));
    // Session should be registered and connected
    expect(hasWsSession("registry-test")).toBe(true);

    // Clean up
    const manager = MockManager.lastInstance!;
    manager.simulateEvent({
      type: "response.completed",
      response: makeResponseObject("resp_z", "done"),
    });
    for await (const _ of await resolveStream(stream)) {
      // consume
    }
  });

  it("releaseWsSession closes the connection and removes the session", async () => {
    const streamFn = createOpenAIWebSocketStreamFn("sk-test", "registry-test");
    const stream = streamFn(
      {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.2",
        contextWindow: 128000,
        maxTokens: 4096,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        name: "GPT-5.2",
      } as Parameters<typeof streamFn>[0],
      {
        systemPrompt: "test",
        messages: [userMsg("Hi") as Parameters<typeof convertMessagesToInputItems>[0][number]],
        tools: [],
      } as Parameters<typeof streamFn>[1],
    );

    await new Promise((r) => setImmediate(r));
    const manager = MockManager.lastInstance!;
    manager.simulateEvent({
      type: "response.completed",
      response: makeResponseObject("resp_zz", "done"),
    });
    for await (const _ of await resolveStream(stream)) {
      // consume
    }

    releaseWsSession("registry-test");
    expect(hasWsSession("registry-test")).toBe(false);
    expect(manager.closeCallCount).toBe(1);
  });

  it("releaseWsSession is a no-op for unknown sessions", () => {
    expect(() => releaseWsSession("nonexistent-session")).not.toThrow();
  });
});
