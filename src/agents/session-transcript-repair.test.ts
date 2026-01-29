import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { sanitizeToolUseArgs, sanitizeToolUseResultPairing } from "./session-transcript-repair.js";

const now = Date.now();

describe("sanitizeToolUseResultPairing", () => {
  it("moves tool results directly after tool calls and inserts missing results", () => {
    const input: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "read", arguments: {} },
          { type: "toolCall", id: "call_2", name: "exec", arguments: {} },
        ],
        timestamp: now,
        api: "openai",
        provider: "openai",
        model: "gpt-4",
      },
      { role: "user", content: "user message that should come after tool use", timestamp: now },
      {
        role: "toolResult",
        toolCallId: "call_2",
        toolName: "exec",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: now,
      },
    ];

    const out = sanitizeToolUseResultPairing(input);
    expect(out[0]?.role).toBe("assistant");
    expect(out[1]?.role).toBe("toolResult");
    expect((out[1] as { toolCallId?: string }).toolCallId).toBe("call_1");
    expect(out[2]?.role).toBe("toolResult");
    expect((out[2] as { toolCallId?: string }).toolCallId).toBe("call_2");
    expect(out[3]?.role).toBe("user");
  });

  it("drops duplicate tool results for the same id within a span", () => {
    const input: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
        timestamp: now,
        api: "openai",
        provider: "openai",
        model: "gpt-4",
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "first" }],
        isError: false,
        timestamp: now,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "second" }],
        isError: false,
        timestamp: now,
      },
      { role: "user", content: "ok", timestamp: now },
    ];

    const out = sanitizeToolUseResultPairing(input);
    expect(out.filter((m) => m.role === "toolResult")).toHaveLength(1);
  });

  it("drops duplicate tool results for the same id across the transcript", () => {
    const input: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
        timestamp: now,
        api: "openai",
        provider: "openai",
        model: "gpt-4",
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "first" }],
        isError: false,
        timestamp: now,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        timestamp: now,
        api: "openai",
        provider: "openai",
        model: "gpt-4",
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "second (duplicate)" }],
        isError: false,
        timestamp: now,
      },
    ];

    const out = sanitizeToolUseResultPairing(input);
    const results = out.filter((m) => m.role === "toolResult") as Array<{
      toolCallId?: string;
    }>;
    expect(results).toHaveLength(1);
    expect(results[0]?.toolCallId).toBe("call_1");
  });

  it("drops orphan tool results that do not match any tool call", () => {
    const input: AgentMessage[] = [
      { role: "user", content: "hello", timestamp: now },
      {
        role: "toolResult",
        toolCallId: "call_orphan",
        toolName: "read",
        content: [{ type: "text", text: "orphan" }],
        isError: false,
        timestamp: now,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        timestamp: now,
        api: "openai",
        provider: "openai",
        model: "gpt-4",
      },
    ];

    const out = sanitizeToolUseResultPairing(input);
    expect(out.some((m) => m.role === "toolResult")).toBe(false);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

describe("sanitizeToolUseArgs", () => {
  it("preserves valid JSON strings in input fields", () => {
    const input: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "read", input: '{"path":"foo.txt"}' } as any,
        ],
        timestamp: now,
        api: "openai",
        provider: "openai",
        model: "gpt-4",
      },
    ];

    const result = sanitizeToolUseArgs(input);
    expect(result.changed).toBe(true);
    const tool = (result.messages[0] as any).content[0];
    expect(tool.input).toEqual({ path: "foo.txt" });
    expect(result.sanitizedCount).toBe(0);
  });

  it("replaces invalid JSON strings with {} and sets metadata", () => {
    const input: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", input: "{ invalid json" } as any],
        timestamp: now,
        api: "openai",
        provider: "openai",
        model: "gpt-4",
      },
    ];

    const result = sanitizeToolUseArgs(input);
    expect(result.changed).toBe(true);
    expect(result.sanitizedCount).toBe(1);
    const tool = (result.messages[0] as any).content[0];
    expect(tool.input).toEqual({});
    expect(tool._sanitized).toBe(true);
    expect(tool._originalInput).toBe("{ invalid json");
  });

  it("preserves already-parsed object values in input fields", () => {
    const input: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "read", input: { path: "bar.txt" } } as any,
        ],
        timestamp: now,
        api: "openai",
        provider: "openai",
        model: "gpt-4",
      },
    ];

    const result = sanitizeToolUseArgs(input);
    expect(result.changed).toBe(false);
    expect(result.messages).toBe(input);
    const tool = (result.messages[0] as any).content[0];
    expect(tool.input).toEqual({ path: "bar.txt" });
  });

  it("handles the 'arguments' alias used by some providers", () => {
    const input: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "read", arguments: '{"path":"baz.txt"}' } as any,
        ],
        timestamp: now,
        api: "openai",
        provider: "openai",
        model: "gpt-4",
      },
    ];

    const result = sanitizeToolUseArgs(input);
    expect(result.changed).toBe(true);
    const tool = (result.messages[0] as any).content[0];
    expect(tool.arguments).toEqual({ path: "baz.txt" });
  });

  it("leaves messages without tool blocks unchanged", () => {
    const input: AgentMessage[] = [
      { role: "user", content: "hello", timestamp: now },
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        timestamp: now,
        api: "openai",
        provider: "openai",
        model: "gpt-4",
      },
    ];

    const result = sanitizeToolUseArgs(input);
    expect(result.changed).toBe(false);
    expect(result.messages).toBe(input);
  });
});
