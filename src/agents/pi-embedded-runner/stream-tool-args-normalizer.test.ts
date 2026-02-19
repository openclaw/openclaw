import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createToolArgsNormalizerWrapper,
  isEmptyObject,
  normalizeEvent,
} from "./stream-tool-args-normalizer.js";

// Mock logger to avoid side-effects
vi.mock("./logger.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePartial(content: AssistantMessage["content"] = []): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function makeToolCall(args: Record<string, unknown> = {}): ToolCall {
  return {
    type: "toolCall",
    id: "call_123",
    name: "test_tool",
    arguments: args,
  };
}

// ── isEmptyObject ────────────────────────────────────────────────────────────

describe("isEmptyObject", () => {
  it("returns true for {}", () => {
    expect(isEmptyObject({})).toBe(true);
  });

  it("returns false for { a: 1 }", () => {
    expect(isEmptyObject({ a: 1 })).toBe(false);
  });

  it("returns false for null", () => {
    expect(isEmptyObject(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isEmptyObject(undefined)).toBe(false);
  });

  it("returns false for []", () => {
    expect(isEmptyObject([])).toBe(false);
  });

  it("returns false for a string", () => {
    expect(isEmptyObject("string")).toBe(false);
  });

  it("returns false for a number", () => {
    expect(isEmptyObject(42)).toBe(false);
  });
});

// ── normalizeEvent ───────────────────────────────────────────────────────────

describe("normalizeEvent", () => {
  it("passes through toolcall_delta with string delta unchanged", () => {
    const map = new Map<number, Record<string, unknown>>();
    const event: AssistantMessageEvent = {
      type: "toolcall_delta",
      contentIndex: 0,
      delta: '{"foo":"bar"}',
      partial: makePartial(),
    };
    const result = normalizeEvent(event, map);
    expect(result).toBe(event);
    expect(map.size).toBe(0);
  });

  it("captures object delta from toolcall_delta", () => {
    const map = new Map<number, Record<string, unknown>>();
    const objectDelta = { command: "ls -la" };
    const event = {
      type: "toolcall_delta" as const,
      contentIndex: 0,
      delta: objectDelta as unknown as string,
      partial: makePartial(),
    } as AssistantMessageEvent;

    const result = normalizeEvent(event, map);
    expect(result).toBe(event);
    expect(map.get(0)).toEqual({ command: "ls -la" });
  });

  it("returns toolcall_end unchanged when arguments are non-empty", () => {
    const map = new Map<number, Record<string, unknown>>();
    const tc = makeToolCall({ command: "ls" });
    const event: AssistantMessageEvent = {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: tc,
      partial: makePartial([tc]),
    };
    const result = normalizeEvent(event, map);
    expect(result).toBe(event);
  });

  it("repairs toolcall_end when arguments are {} and captured object exists", () => {
    const map = new Map<number, Record<string, unknown>>();
    map.set(0, { command: "ls -la" });

    const tc = makeToolCall({});
    const event: AssistantMessageEvent = {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: tc,
      partial: makePartial([tc]),
    };

    const result = normalizeEvent(event, map);
    expect(result).not.toBe(event);
    expect(result.type).toBe("toolcall_end");
    if (result.type === "toolcall_end") {
      expect(result.toolCall.arguments).toEqual({ command: "ls -la" });
      const contentItem = result.partial.content[0];
      expect(contentItem.type).toBe("toolCall");
      if (contentItem.type === "toolCall") {
        expect(contentItem.arguments).toEqual({ command: "ls -la" });
      }
    }
  });

  it("returns toolcall_end unchanged when arguments are {} but no captured object", () => {
    const map = new Map<number, Record<string, unknown>>();
    const tc = makeToolCall({});
    const event: AssistantMessageEvent = {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: tc,
      partial: makePartial([tc]),
    };
    const result = normalizeEvent(event, map);
    expect(result).toBe(event);
  });

  it("tracks multiple content indices independently", () => {
    const map = new Map<number, Record<string, unknown>>();
    const obj0 = { command: "ls" };
    const obj1 = { file: "test.txt" };

    // Capture two different deltas at different indices
    normalizeEvent(
      {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: obj0 as unknown as string,
        partial: makePartial(),
      } as AssistantMessageEvent,
      map,
    );
    normalizeEvent(
      {
        type: "toolcall_delta",
        contentIndex: 1,
        delta: obj1 as unknown as string,
        partial: makePartial(),
      } as AssistantMessageEvent,
      map,
    );

    expect(map.get(0)).toEqual({ command: "ls" });
    expect(map.get(1)).toEqual({ file: "test.txt" });
  });

  it("passes through text_delta and other non-toolcall events unchanged", () => {
    const map = new Map<number, Record<string, unknown>>();
    const textEvent: AssistantMessageEvent = {
      type: "text_delta",
      contentIndex: 0,
      delta: "hello",
      partial: makePartial(),
    };
    expect(normalizeEvent(textEvent, map)).toBe(textEvent);

    const startEvent: AssistantMessageEvent = {
      type: "start",
      partial: makePartial(),
    };
    expect(normalizeEvent(startEvent, map)).toBe(startEvent);
  });

  it("repairs done event when tool calls have empty arguments", () => {
    const map = new Map<number, Record<string, unknown>>();
    map.set(1, { command: "ls -la" });

    const tc0: ToolCall = { type: "toolCall", id: "c0", name: "tool_a", arguments: { x: 1 } };
    const tc1: ToolCall = { type: "toolCall", id: "c1", name: "tool_b", arguments: {} };

    const msg = makePartial([tc0, tc1]);
    const event: AssistantMessageEvent = {
      type: "done",
      reason: "toolUse",
      message: msg,
    };

    const result = normalizeEvent(event, map);
    expect(result).not.toBe(event);
    if (result.type === "done") {
      expect(result.message.content[0]).toEqual(tc0); // unchanged
      const repaired = result.message.content[1];
      expect(repaired.type).toBe("toolCall");
      if (repaired.type === "toolCall") {
        expect(repaired.arguments).toEqual({ command: "ls -la" });
      }
    }
  });

  it("returns done event unchanged when no captured args", () => {
    const map = new Map<number, Record<string, unknown>>();
    const msg = makePartial([makeToolCall({ a: 1 })]);
    const event: AssistantMessageEvent = {
      type: "done",
      reason: "stop",
      message: msg,
    };
    expect(normalizeEvent(event, map)).toBe(event);
  });
});

// ── createToolArgsNormalizerWrapper integration ──────────────────────────────

describe("createToolArgsNormalizerWrapper", () => {
  it("repairs tool args from object delta through full stream", async () => {
    const objectArgs = { command: "ls -la", timeout: 5000 };
    const tc = makeToolCall({});

    // Build a mock stream that simulates a provider returning object deltas
    const sourceStream = createAssistantMessageEventStream();

    const baseStreamFn = vi.fn().mockReturnValue(sourceStream);
    const wrapped = createToolArgsNormalizerWrapper(baseStreamFn);

    const resultStream = wrapped(
      {
        id: "test",
        api: "openai-completions",
        provider: "test",
      } as unknown as Parameters<StreamFn>[0],
      { messages: [] },
      {},
    );

    // Collect events from the wrapped stream
    const events: AssistantMessageEvent[] = [];
    const collectPromise = (async () => {
      for await (const event of resultStream as AsyncIterable<AssistantMessageEvent>) {
        events.push(event);
      }
    })();

    // Push events to the source stream
    sourceStream.push({
      type: "toolcall_start",
      contentIndex: 0,
      partial: makePartial(),
    });
    sourceStream.push({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: objectArgs as unknown as string,
      partial: makePartial(),
    } as AssistantMessageEvent);
    sourceStream.push({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: tc,
      partial: makePartial([tc]),
    });
    const doneMsg = makePartial([tc]);
    doneMsg.stopReason = "toolUse";
    sourceStream.push({
      type: "done",
      reason: "toolUse",
      message: doneMsg,
    });

    await collectPromise;

    // Verify the toolcall_end was repaired
    const toolcallEnd = events.find((e) => e.type === "toolcall_end");
    expect(toolcallEnd).toBeDefined();
    if (toolcallEnd?.type === "toolcall_end") {
      expect(toolcallEnd.toolCall.arguments).toEqual(objectArgs);
    }

    // Verify the done event was also repaired
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    if (doneEvent?.type === "done") {
      const content = doneEvent.message.content[0];
      if (content.type === "toolCall") {
        expect(content.arguments).toEqual(objectArgs);
      }
    }
  });

  it("passes through normal string-delta streams without modification", async () => {
    const tc = makeToolCall({ command: "ls" });
    const sourceStream = createAssistantMessageEventStream();

    const baseStreamFn = vi.fn().mockReturnValue(sourceStream);
    const wrapped = createToolArgsNormalizerWrapper(baseStreamFn);

    const resultStream = wrapped(
      {
        id: "test",
        api: "openai-completions",
        provider: "test",
      } as unknown as Parameters<StreamFn>[0],
      { messages: [] },
      {},
    );

    const events: AssistantMessageEvent[] = [];
    const collectPromise = (async () => {
      for await (const event of resultStream as AsyncIterable<AssistantMessageEvent>) {
        events.push(event);
      }
    })();

    sourceStream.push({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: '{"command":"ls"}',
      partial: makePartial(),
    });
    sourceStream.push({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: tc,
      partial: makePartial([tc]),
    });
    sourceStream.push({
      type: "done",
      reason: "toolUse",
      message: makePartial([tc]),
    });

    await collectPromise;

    // toolcall_end should be unchanged (arguments are already populated)
    const toolcallEnd = events.find((e) => e.type === "toolcall_end");
    if (toolcallEnd?.type === "toolcall_end") {
      expect(toolcallEnd.toolCall.arguments).toEqual({ command: "ls" });
    }
  });

  it("handles Promise-returning base stream functions", async () => {
    const sourceStream = createAssistantMessageEventStream();
    const baseStreamFn = vi.fn().mockResolvedValue(sourceStream);
    const wrapped = createToolArgsNormalizerWrapper(baseStreamFn);

    const resultPromise = wrapped(
      {
        id: "test",
        api: "openai-completions",
        provider: "test",
      } as unknown as Parameters<StreamFn>[0],
      { messages: [] },
      {},
    );

    // The result should be a promise since the base returned a promise
    expect(resultPromise).toBeInstanceOf(Promise);

    const resultStream = await (resultPromise as Promise<unknown>);

    const events: AssistantMessageEvent[] = [];
    const collectPromise = (async () => {
      for await (const event of resultStream as AsyncIterable<AssistantMessageEvent>) {
        events.push(event);
      }
    })();

    sourceStream.push({
      type: "done",
      reason: "stop",
      message: makePartial(),
    });

    await collectPromise;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("done");
  });
});
