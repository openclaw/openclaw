import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, Readable, Writable } from "node:stream";

import type { CliBackendConfig, StreamingFormat } from "../../config/types.js";
import {
  runCliWithStreaming,
  mapClaudeStreamEvent,
  mapCodexStreamEvent,
  mapCliStreamEvent,
  type CliStreamEvent,
} from "./streaming.js";

// Mock child_process.spawn
const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

function createMockProcess() {
  const stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const proc = new EventEmitter() as ChildProcessWithoutNullStreams;
  proc.stdin = stdin as ChildProcessWithoutNullStreams["stdin"];
  proc.stdout = stdout as ChildProcessWithoutNullStreams["stdout"];
  proc.stderr = stderr as ChildProcessWithoutNullStreams["stderr"];
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
    return true;
  });
  return proc;
}

// Helper to wait for readline to process a line
function nextTick(): Promise<void> {
  return new Promise((resolve) => process.nextTick(resolve));
}

describe("runCliWithStreaming", () => {
  const defaultBackend: CliBackendConfig = {
    command: "claude",
    sessionIdFields: ["session_id"],
    usageFields: {
      input: ["input_tokens"],
      output: ["output_tokens"],
    },
  };

  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("parses NDJSON lines and accumulates text from text events", async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);

    const events: CliStreamEvent[] = [];
    const promise = runCliWithStreaming({
      command: "claude",
      args: ["-p"],
      cwd: "/tmp",
      env: {},
      timeoutMs: 5000,
      backend: defaultBackend,
      onEvent: (e) => events.push(e),
    });

    // Give readline time to set up
    await nextTick();

    // Emit streaming events
    proc.stdout.push('{"type":"text","text":"Hello "}\n');
    proc.stdout.push('{"type":"text","text":"world!"}\n');
    proc.stdout.push(
      '{"type":"result","session_id":"sess-123","usage":{"input_tokens":10,"output_tokens":5}}\n',
    );
    proc.stdout.push(null);

    await nextTick();
    proc.emit("close", 0, null);

    const result = await promise;

    expect(result.text).toBe("Hello world!");
    expect(result.sessionId).toBe("sess-123");
    expect(result.usage).toEqual({ input: 10, output: 5 });
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: "text", text: "Hello " });
    expect(events[1]).toEqual({ type: "text", text: "world!" });
  });

  it("emits cumulative text with delta when using streamingFormat config", async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);

    const backendWithFormat: CliBackendConfig = {
      ...defaultBackend,
      streamingFormat: {
        text: {
          eventTypes: ["assistant"],
          contentPath: "message.content",
          matchType: "text",
          textField: "text",
        },
      },
    };

    const events: CliStreamEvent[] = [];
    const promise = runCliWithStreaming({
      command: "claude",
      args: ["-p"],
      cwd: "/tmp",
      env: {},
      timeoutMs: 5000,
      backend: backendWithFormat,
      onEvent: (e) => events.push(e),
    });

    await nextTick();

    // Claude CLI format: assistant events with nested content
    proc.stdout.push(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello "}]}}\n',
    );
    proc.stdout.push(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"world!"}]}}\n',
    );
    proc.stdout.push(null);

    await nextTick();
    proc.emit("close", 0, null);

    const result = await promise;

    expect(result.text).toBe("Hello world!");

    // Find text events (onEvent receives extracted events)
    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents).toHaveLength(2);

    // First text event: cumulative = "Hello" (trimmed), delta = "Hello"
    // parseReplyDirectives trims trailing whitespace
    expect(textEvents[0]).toEqual({
      type: "text",
      text: "Hello",
      delta: "Hello",
    });

    // Second text event: cumulative = "Hello world!", delta = " world!" (space preserved in delta)
    expect(textEvents[1]).toEqual({
      type: "text",
      text: "Hello world!",
      delta: " world!",
    });
  });

  it("filters events by type when streamingEventTypes is specified", async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);

    const events: CliStreamEvent[] = [];
    const promise = runCliWithStreaming({
      command: "claude",
      args: ["-p"],
      cwd: "/tmp",
      env: {},
      timeoutMs: 5000,
      eventTypes: ["text"],
      backend: defaultBackend,
      onEvent: (e) => events.push(e),
    });

    await nextTick();

    proc.stdout.push('{"type":"text","text":"Hello"}\n');
    proc.stdout.push('{"type":"tool_use","name":"bash"}\n');
    proc.stdout.push('{"type":"result"}\n');
    proc.stdout.push(null);

    await nextTick();
    proc.emit("close", 0, null);

    await promise;

    // Only "text" events should be emitted
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("text");
  });

  it("supports prefix matching for event types", async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);

    const events: CliStreamEvent[] = [];
    const promise = runCliWithStreaming({
      command: "codex",
      args: ["exec"],
      cwd: "/tmp",
      env: {},
      timeoutMs: 5000,
      eventTypes: ["item"],
      backend: { ...defaultBackend, sessionIdFields: ["thread_id"] },
      onEvent: (e) => events.push(e),
    });

    await nextTick();

    proc.stdout.push('{"type":"item.created","item":{"type":"message"}}\n');
    proc.stdout.push('{"type":"item.completed","item":{"type":"message","text":"Done"}}\n');
    proc.stdout.push('{"type":"turn.completed"}\n');
    proc.stdout.push(null);

    await nextTick();
    proc.emit("close", 0, null);

    await promise;

    // "item" prefix should match "item.created" and "item.completed"
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.type)).toEqual(["item.created", "item.completed"]);
  });

  it("handles malformed JSON lines gracefully", async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);

    const events: CliStreamEvent[] = [];
    const promise = runCliWithStreaming({
      command: "claude",
      args: ["-p"],
      cwd: "/tmp",
      env: {},
      timeoutMs: 5000,
      backend: defaultBackend,
      onEvent: (e) => events.push(e),
    });

    await nextTick();

    proc.stdout.push('{"type":"text","text":"Valid"}\n');
    proc.stdout.push("not valid json\n");
    proc.stdout.push('{"type":"text","text":" line"}\n');
    proc.stdout.push(null);

    await nextTick();
    proc.emit("close", 0, null);

    const result = await promise;

    expect(result.text).toBe("Valid line");
    expect(events).toHaveLength(2);
  });

  it("rejects on non-zero exit code with stderr", async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);

    const promise = runCliWithStreaming({
      command: "claude",
      args: ["-p"],
      cwd: "/tmp",
      env: {},
      timeoutMs: 5000,
      backend: defaultBackend,
      onEvent: () => {},
    });

    await nextTick();

    proc.stderr.push("Error: API key invalid");
    proc.stderr.push(null);

    await nextTick();
    proc.emit("close", 1, null);

    await expect(promise).rejects.toThrow("Error: API key invalid");
  });

  it("rejects on timeout", async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);

    const promise = runCliWithStreaming({
      command: "claude",
      args: ["-p"],
      cwd: "/tmp",
      env: {},
      timeoutMs: 50, // Short timeout for test
      backend: defaultBackend,
      onEvent: () => {},
    });

    // Don't close the process - let it timeout
    await expect(promise).rejects.toThrow("CLI streaming timeout after 50ms");
  });

  it("extracts session ID from Claude CLI result event", async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);

    const promise = runCliWithStreaming({
      command: "claude",
      args: ["-p"],
      cwd: "/tmp",
      env: {},
      timeoutMs: 5000,
      backend: defaultBackend,
      onEvent: () => {},
    });

    await nextTick();

    proc.stdout.push('{"type":"result","session_id":"my-session-id"}\n');
    proc.stdout.push(null);

    await nextTick();
    proc.emit("close", 0, null);

    const result = await promise;
    expect(result.sessionId).toBe("my-session-id");
  });

  it("extracts thread_id from Codex CLI events", async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);

    const promise = runCliWithStreaming({
      command: "codex",
      args: ["exec"],
      cwd: "/tmp",
      env: {},
      timeoutMs: 5000,
      backend: { ...defaultBackend, sessionIdFields: ["thread_id"] },
      onEvent: () => {},
    });

    await nextTick();

    proc.stdout.push('{"type":"turn.completed","thread_id":"thread-abc"}\n');
    proc.stdout.push(null);

    await nextTick();
    proc.emit("close", 0, null);

    const result = await promise;
    expect(result.sessionId).toBe("thread-abc");
  });

  it("extracts tool_use and tool_result with streamingFormat config", async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);

    const backendWithFormat: CliBackendConfig = {
      ...defaultBackend,
      streamingFormat: {
        toolUse: {
          eventTypes: ["assistant"],
          contentPath: "message.content",
          matchType: "tool_use",
          idField: "id",
          nameField: "name",
          inputField: "input",
        },
        toolResult: {
          eventTypes: ["user"],
          contentPath: "message.content",
          matchType: "tool_result",
          idField: "tool_use_id",
          outputField: "content",
          isErrorField: "is_error",
        },
      },
    };

    const events: CliStreamEvent[] = [];
    const promise = runCliWithStreaming({
      command: "claude",
      args: ["-p"],
      cwd: "/tmp",
      env: {},
      timeoutMs: 5000,
      backend: backendWithFormat,
      onEvent: (e) => events.push(e),
    });

    await nextTick();

    // Tool use event
    proc.stdout.push(
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-1","name":"bash","input":{"cmd":"ls"}}]}}\n',
    );
    // Tool result event
    proc.stdout.push(
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":"file.txt","is_error":false}]}}\n',
    );
    proc.stdout.push(null);

    await nextTick();
    proc.emit("close", 0, null);

    await promise;

    const toolUseEvents = events.filter((e) => e.type === "tool_use");
    const toolResultEvents = events.filter((e) => e.type === "tool_result");

    expect(toolUseEvents).toHaveLength(1);
    expect(toolUseEvents[0]).toMatchObject({
      type: "tool_use",
      id: "tool-1",
      name: "bash",
      input: { cmd: "ls" },
    });

    expect(toolResultEvents).toHaveLength(1);
    expect(toolResultEvents[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tool-1",
      content: "file.txt",
      is_error: false,
    });
  });
});

describe("mapClaudeStreamEvent", () => {
  it("maps tool_use event to tool start", () => {
    const event: CliStreamEvent = {
      type: "tool_use",
      id: "tool-1",
      name: "bash",
      input: { command: "ls" },
    };

    const result = mapClaudeStreamEvent(event);

    expect(result).toEqual({
      stream: "tool",
      data: {
        phase: "start",
        name: "bash",
        id: "tool-1",
        input: { command: "ls" },
      },
    });
  });

  it("maps tool_result event to tool end", () => {
    const event: CliStreamEvent = {
      type: "tool_result",
      tool_use_id: "tool-1",
      content: "file1.txt\nfile2.txt",
      is_error: false,
    };

    const result = mapClaudeStreamEvent(event);

    expect(result).toEqual({
      stream: "tool",
      data: {
        phase: "end",
        id: "tool-1",
        output: "file1.txt\nfile2.txt",
        isError: false,
      },
    });
  });

  it("maps text event to assistant with cumulative text and delta", () => {
    const event: CliStreamEvent = { type: "text", text: "Hello world!", delta: "world!" };

    const result = mapClaudeStreamEvent(event);

    expect(result).toEqual({
      stream: "assistant",
      data: { text: "Hello world!", delta: "world!" },
    });
  });

  it("maps text event without explicit delta (delta defaults to text)", () => {
    const event: CliStreamEvent = { type: "text", text: "Hello" };

    const result = mapClaudeStreamEvent(event);

    expect(result).toEqual({
      stream: "assistant",
      data: { text: "Hello", delta: "Hello" },
    });
  });

  it("returns null for empty text event", () => {
    const event: CliStreamEvent = { type: "text", text: "" };
    expect(mapClaudeStreamEvent(event)).toBeNull();
  });

  it("returns null for result event", () => {
    const event: CliStreamEvent = { type: "result" };
    expect(mapClaudeStreamEvent(event)).toBeNull();
  });
});

describe("mapCodexStreamEvent", () => {
  it("maps item.created function_call to tool start", () => {
    const event: CliStreamEvent = {
      type: "item.created",
      item: {
        type: "function_call",
        id: "call-1",
        name: "shell",
        arguments: '{"cmd":"ls"}',
      },
    };

    const result = mapCodexStreamEvent(event);

    expect(result).toEqual({
      stream: "tool",
      data: {
        phase: "start",
        name: "shell",
        id: "call-1",
        input: '{"cmd":"ls"}',
      },
    });
  });

  it("maps item.completed function_call_output to tool end", () => {
    const event: CliStreamEvent = {
      type: "item.completed",
      item: {
        type: "function_call_output",
        call_id: "call-1",
        output: "file1.txt",
      },
    };

    const result = mapCodexStreamEvent(event);

    expect(result).toEqual({
      stream: "tool",
      data: {
        phase: "end",
        id: "call-1",
        output: "file1.txt",
      },
    });
  });

  it("maps item.completed message to assistant text with delta", () => {
    const event: CliStreamEvent = {
      type: "item.completed",
      item: {
        type: "message",
        text: "Task completed",
      },
    };

    const result = mapCodexStreamEvent(event);

    expect(result).toEqual({
      stream: "assistant",
      data: { text: "Task completed", delta: "Task completed" },
    });
  });

  it("returns null for turn.completed", () => {
    const event: CliStreamEvent = { type: "turn.completed" };
    expect(mapCodexStreamEvent(event)).toBeNull();
  });
});

describe("mapCliStreamEvent", () => {
  it("maps text event with cumulative text and delta", () => {
    const event: CliStreamEvent = { type: "text", text: "Hello world!", delta: "world!" };
    const result = mapCliStreamEvent(event, "claude-cli");

    expect(result).toEqual({
      stream: "assistant",
      data: { text: "Hello world!", delta: "world!" },
    });
  });

  it("maps tool_use event directly", () => {
    const event: CliStreamEvent = {
      type: "tool_use",
      id: "tool-1",
      name: "bash",
      input: { command: "ls" },
    };
    const result = mapCliStreamEvent(event, "claude-cli");

    expect(result).toEqual({
      stream: "tool",
      data: {
        phase: "start",
        name: "bash",
        id: "tool-1",
        input: { command: "ls" },
      },
    });
  });

  it("maps tool_result event directly", () => {
    const event: CliStreamEvent = {
      type: "tool_result",
      tool_use_id: "tool-1",
      content: "output",
      is_error: true,
    };
    const result = mapCliStreamEvent(event, "claude-cli");

    expect(result).toEqual({
      stream: "tool",
      data: {
        phase: "end",
        id: "tool-1",
        output: "output",
        isError: true,
      },
    });
  });

  it("uses Codex mapper for codex-cli backend", () => {
    const event: CliStreamEvent = {
      type: "item.completed",
      item: { type: "message", text: "Done" },
    };
    const result = mapCliStreamEvent(event, "codex-cli");

    expect(result).toEqual({
      stream: "assistant",
      data: { text: "Done", delta: "Done" },
    });
  });

  it("detects Codex format from event type prefix", () => {
    const event: CliStreamEvent = {
      type: "item.created",
      item: { type: "function_call", name: "test", id: "1" },
    };
    // Even with non-codex backend name, detects format from event type
    const result = mapCliStreamEvent(event, "custom-backend");

    expect(result).toEqual({
      stream: "tool",
      data: { phase: "start", name: "test", id: "1", input: undefined },
    });
  });

  it("accepts optional format parameter", () => {
    const format: StreamingFormat = {
      text: { eventTypes: ["text"], textField: "text" },
    };
    const event: CliStreamEvent = { type: "text", text: "Hello", delta: "Hello" };
    const result = mapCliStreamEvent(event, "claude-cli", format);

    expect(result).toEqual({
      stream: "assistant",
      data: { text: "Hello", delta: "Hello" },
    });
  });

  it("passes through mediaUrls when present", () => {
    const event: CliStreamEvent = {
      type: "text",
      text: "Here is an image",
      delta: "image",
      mediaUrls: ["https://example.com/img.png"],
    };
    const result = mapCliStreamEvent(event, "claude-cli");

    expect(result).toEqual({
      stream: "assistant",
      data: {
        text: "Here is an image",
        delta: "image",
        mediaUrls: ["https://example.com/img.png"],
      },
    });
  });

  it("omits mediaUrls when empty array", () => {
    const event: CliStreamEvent = {
      type: "text",
      text: "Hello",
      delta: "Hello",
      mediaUrls: [],
    };
    const result = mapCliStreamEvent(event, "claude-cli");

    expect(result).toEqual({
      stream: "assistant",
      data: { text: "Hello", delta: "Hello" },
    });
  });
});

describe("runCliWithStreaming - directive parsing", () => {
  const defaultBackend: CliBackendConfig = {
    command: "claude",
    sessionIdFields: ["session_id"],
  };

  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("parses reply directives and extracts mediaUrls from text", async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);

    const backendWithFormat: CliBackendConfig = {
      ...defaultBackend,
      streamingFormat: {
        text: {
          eventTypes: ["assistant"],
          contentPath: "message.content",
          matchType: "text",
          textField: "text",
        },
      },
    };

    const events: CliStreamEvent[] = [];
    const promise = runCliWithStreaming({
      command: "claude",
      args: ["-p"],
      cwd: "/tmp",
      env: {},
      timeoutMs: 5000,
      backend: backendWithFormat,
      onEvent: (e) => events.push(e),
    });

    await nextTick();

    // Text with MEDIA token should have media extracted and text cleaned
    proc.stdout.push(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Here is the image\\nMEDIA: https://example.com/img.png"}]}}\n',
    );
    proc.stdout.push(null);

    await nextTick();
    proc.emit("close", 0, null);

    await promise;

    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0]?.text).toBe("Here is the image");
    expect(textEvents[0]?.mediaUrls).toEqual(["https://example.com/img.png"]);
  });

  it("computes delta correctly after directive parsing", async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);

    const backendWithFormat: CliBackendConfig = {
      ...defaultBackend,
      streamingFormat: {
        text: {
          eventTypes: ["assistant"],
          contentPath: "message.content",
          matchType: "text",
          textField: "text",
        },
      },
    };

    const events: CliStreamEvent[] = [];
    const promise = runCliWithStreaming({
      command: "claude",
      args: ["-p"],
      cwd: "/tmp",
      env: {},
      timeoutMs: 5000,
      backend: backendWithFormat,
      onEvent: (e) => events.push(e),
    });

    await nextTick();

    // First chunk
    proc.stdout.push(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello "}]}}\n',
    );
    // Second chunk
    proc.stdout.push(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"world!"}]}}\n',
    );
    proc.stdout.push(null);

    await nextTick();
    proc.emit("close", 0, null);

    await promise;

    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents).toHaveLength(2);

    // First event: text="Hello" (trimmed), delta="Hello"
    // parseReplyDirectives trims trailing whitespace
    expect(textEvents[0]?.text).toBe("Hello");
    expect(textEvents[0]?.delta).toBe("Hello");

    // Second event: text="Hello world!", delta=" world!" (space preserved in delta)
    expect(textEvents[1]?.text).toBe("Hello world!");
    expect(textEvents[1]?.delta).toBe(" world!");
  });
});
