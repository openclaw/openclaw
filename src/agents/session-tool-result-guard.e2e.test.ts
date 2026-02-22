import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";

type AppendMessage = Parameters<SessionManager["appendMessage"]>[0];

const asAppendMessage = (message: unknown) => message as AppendMessage;

const toolCallMessage = asAppendMessage({
  role: "assistant",
  content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
});

function appendToolResultText(sm: SessionManager, text: string) {
  sm.appendMessage(toolCallMessage);
  sm.appendMessage(
    asAppendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: Date.now(),
    }),
  );
}

function getPersistedMessages(sm: SessionManager): AgentMessage[] {
  return sm
    .getEntries()
    .filter((e) => e.type === "message")
    .map((e) => (e as { message: AgentMessage }).message);
}

function expectPersistedRoles(sm: SessionManager, expectedRoles: AgentMessage["role"][]) {
  const messages = getPersistedMessages(sm);
  expect(messages.map((message) => message.role)).toEqual(expectedRoles);
  return messages;
}

function getToolResultText(messages: AgentMessage[]): string {
  const toolResult = messages.find((m) => m.role === "toolResult") as {
    content: Array<{ type: string; text: string }>;
  };
  expect(toolResult).toBeDefined();
  const textBlock = toolResult.content.find((b: { type: string }) => b.type === "text") as {
    text: string;
  };
  return textBlock.text;
}

describe("installSessionToolResultGuard", () => {
  it("inserts synthetic toolResult before non-tool message when pending", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage(toolCallMessage);
    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "text", text: "error" }],
        stopReason: "error",
      }),
    );

    const messages = expectPersistedRoles(sm, ["assistant", "toolResult", "assistant"]);
    const synthetic = messages[1] as {
      toolCallId?: string;
      isError?: boolean;
      content?: Array<{ type?: string; text?: string }>;
    };
    expect(synthetic.toolCallId).toBe("call_1");
    expect(synthetic.isError).toBe(true);
    expect(synthetic.content?.[0]?.text).toContain("missing tool result");
  });

  it("flushes pending tool calls when asked explicitly", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm);

    sm.appendMessage(toolCallMessage);
    guard.flushPendingToolResults();

    expectPersistedRoles(sm, ["assistant", "toolResult"]);
  });

  it("does not add synthetic toolResult when a matching one exists", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage(toolCallMessage);
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      }),
    );

    expectPersistedRoles(sm, ["assistant", "toolResult"]);
  });

  it("preserves ordering with multiple tool calls and partial results", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm);

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_a", name: "one", arguments: {} },
          { type: "toolUse", id: "call_b", name: "two", arguments: {} },
        ],
      }),
    );
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolUseId: "call_a",
        content: [{ type: "text", text: "a" }],
        isError: false,
      }),
    );
    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "text", text: "after tools" }],
      }),
    );

    const messages = expectPersistedRoles(sm, [
      "assistant", // tool calls
      "toolResult", // call_a real
      "toolResult", // synthetic for call_b
      "assistant", // text
    ]);
    expect((messages[2] as { toolCallId?: string }).toolCallId).toBe("call_b");
    expect(guard.getPendingIds()).toEqual([]);
  });

  it("flushes pending on guard when no toolResult arrived", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm);

    sm.appendMessage(toolCallMessage);
    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "text", text: "hard error" }],
        stopReason: "error",
      }),
    );
    expect(guard.getPendingIds()).toEqual([]);
  });

  it("handles toolUseId on toolResult", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolUse", id: "use_1", name: "f", arguments: {} }],
      }),
    );
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolUseId: "use_1",
        content: [{ type: "text", text: "ok" }],
      }),
    );

    expectPersistedRoles(sm, ["assistant", "toolResult"]);
  });

  it("drops malformed tool calls missing input before persistence", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read" }],
      }),
    );

    const messages = getPersistedMessages(sm);
    expect(messages).toHaveLength(0);
  });

  it("drops malformed tool calls with invalid name tokens before persistence", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_bad_name",
            name: 'toolu_01mvznfebfuu <|tool_call_argument_begin|> {"command"',
            arguments: {},
          },
        ],
      }),
    );

    expect(getPersistedMessages(sm)).toHaveLength(0);
  });

  it("drops tool calls not present in allowedToolNames", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm, {
      allowedToolNames: ["read"],
    });

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "write", arguments: {} }],
      }),
    );

    expect(getPersistedMessages(sm)).toHaveLength(0);
  });

  it("flushes pending tool results when a sanitized assistant message is dropped", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      }),
    );

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_2", name: "read" }],
      }),
    );

    expectPersistedRoles(sm, ["assistant", "toolResult"]);
  });

  it("caps oversized tool result text during persistence", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    appendToolResultText(sm, "x".repeat(500_000));

    const text = getToolResultText(getPersistedMessages(sm));
    expect(text.length).toBeLessThan(500_000);
    expect(text).toContain("truncated");
  });

  it("does not truncate tool results under the limit", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    const originalText = "small tool result";
    appendToolResultText(sm, originalText);

    const text = getToolResultText(getPersistedMessages(sm));
    expect(text).toBe(originalText);
  });

  it("blocks persistence when before_message_write returns block=true", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm, {
      beforeMessageWriteHook: () => ({ block: true }),
    });

    sm.appendMessage(
      asAppendMessage({
        role: "user",
        content: "hidden",
        timestamp: Date.now(),
      }),
    );

    expect(getPersistedMessages(sm)).toHaveLength(0);
  });

  it("applies before_message_write message mutations before persistence", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm, {
      beforeMessageWriteHook: ({ message }) => {
        if ((message as { role?: string }).role !== "toolResult") {
          return undefined;
        }
        return {
          message: {
            ...(message as unknown as Record<string, unknown>),
            content: [{ type: "text", text: "rewritten by hook" }],
          } as unknown as AgentMessage,
        };
      },
    });

    appendToolResultText(sm, "original");

    const text = getToolResultText(getPersistedMessages(sm));
    expect(text).toBe("rewritten by hook");
  });

  it("applies before_message_write to synthetic tool-result flushes", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm, {
      beforeMessageWriteHook: ({ message }) => {
        if ((message as { role?: string }).role !== "toolResult") {
          return undefined;
        }
        return { block: true };
      },
    });

    sm.appendMessage(toolCallMessage);
    guard.flushPendingToolResults();

    const messages = getPersistedMessages(sm);
    expect(messages.map((m) => m.role)).toEqual(["assistant"]);
  });

  it("applies message persistence transform to user messages", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm, {
      transformMessageForPersistence: (message) =>
        (message as { role?: string }).role === "user"
          ? ({
              ...(message as unknown as Record<string, unknown>),
              provenance: { kind: "inter_session", sourceTool: "sessions_send" },
            } as unknown as AgentMessage)
          : message,
    });

    sm.appendMessage(
      asAppendMessage({
        role: "user",
        content: "forwarded",
        timestamp: Date.now(),
      }),
    );

    const persisted = sm.getEntries().find((e) => e.type === "message") as
      | { message?: Record<string, unknown> }
      | undefined;
    expect(persisted?.message?.role).toBe("user");
    expect(persisted?.message?.provenance).toEqual({
      kind: "inter_session",
      sourceTool: "sessions_send",
    });
  });

  // --- safeAppend write-failure tests ---

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("catches write failure on main message path without throwing", () => {
    const sm = SessionManager.inMemory();

    // Patch appendMessage to throw BEFORE installing the guard,
    // so originalAppend captures the throwing function.
    sm.appendMessage = (() => {
      throw new Error("EACCES: permission denied");
    }) as SessionManager["appendMessage"];

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    installSessionToolResultGuard(sm);

    // Should not throw
    sm.appendMessage(
      asAppendMessage({
        role: "user",
        content: "hello",
        timestamp: Date.now(),
      }),
    );

    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toContain("session write failed");
    expect(spy.mock.calls[0][0]).toContain("EACCES");
  });

  it("catches write failure on tool result path and clears pending IDs", () => {
    const sm = SessionManager.inMemory();
    const realAppend = sm.appendMessage.bind(sm);
    let callCount = 0;

    // Throw only on the second originalAppend call (the tool result write).
    sm.appendMessage = ((msg: AppendMessage) => {
      callCount++;
      if (callCount === 2) {
        throw new Error("EACCES: permission denied");
      }
      return realAppend(msg);
    }) as SessionManager["appendMessage"];

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const guard = installSessionToolResultGuard(sm);

    // First: tool call (originalAppend call 1 — succeeds)
    sm.appendMessage(toolCallMessage);
    // Second: tool result (originalAppend call 2 — throws, caught by safeAppend)
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      }),
    );

    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0][0]).toContain("session write failed");
    expect(guard.getPendingIds()).toEqual([]);
  });

  it("catches write failure in flushPendingToolResults and clears pending IDs", () => {
    const sm = SessionManager.inMemory();

    // Always throw
    sm.appendMessage = (() => {
      throw new Error("EACCES: permission denied");
    }) as SessionManager["appendMessage"];

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const guard = installSessionToolResultGuard(sm);

    // Append tool call — safeAppend catches the error, but pending IDs are still set
    sm.appendMessage(toolCallMessage);

    // Flush — safeAppend catches the error, then pending.clear() runs
    guard.flushPendingToolResults();

    expect(spy).toHaveBeenCalled();
    expect(guard.getPendingIds()).toEqual([]);
  });

  it("write failure does not affect subsequent successful writes", () => {
    const sm = SessionManager.inMemory();
    const realAppend = sm.appendMessage.bind(sm);
    let callCount = 0;

    // Throw only on the first call, succeed after that.
    sm.appendMessage = ((msg: AppendMessage) => {
      callCount++;
      if (callCount === 1) {
        throw new Error("EACCES: permission denied");
      }
      return realAppend(msg);
    }) as SessionManager["appendMessage"];

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    installSessionToolResultGuard(sm);

    // First write: fails silently
    sm.appendMessage(
      asAppendMessage({
        role: "user",
        content: "first",
        timestamp: Date.now(),
      }),
    );
    expect(spy).toHaveBeenCalledOnce();

    // Second write: succeeds
    sm.appendMessage(
      asAppendMessage({
        role: "user",
        content: "second",
        timestamp: Date.now(),
      }),
    );

    const messages = getPersistedMessages(sm);
    expect(messages).toHaveLength(1);
    expect((messages[0] as { content?: string }).content).toBe("second");
  });

  it("includes getSessionFile() path in error log when available", () => {
    const sm = SessionManager.inMemory();

    // Add getSessionFile to the session manager
    (sm as unknown as { getSessionFile: () => string }).getSessionFile = () =>
      "/path/to/session.jsonl";

    // Make append throw
    sm.appendMessage = (() => {
      throw new Error("EACCES: permission denied");
    }) as SessionManager["appendMessage"];

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    installSessionToolResultGuard(sm);

    sm.appendMessage(
      asAppendMessage({
        role: "user",
        content: "test",
        timestamp: Date.now(),
      }),
    );

    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0][0]).toContain("/path/to/session.jsonl");
  });

  it("falls back to 'unknown' when getSessionFile is unavailable", () => {
    const sm = SessionManager.inMemory();

    // Make append throw — SessionManager.inMemory() has no getSessionFile
    sm.appendMessage = (() => {
      throw new Error("EACCES: permission denied");
    }) as SessionManager["appendMessage"];

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    installSessionToolResultGuard(sm);

    sm.appendMessage(
      asAppendMessage({
        role: "user",
        content: "test",
        timestamp: Date.now(),
      }),
    );

    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0][0]).toContain("unknown");
  });
});
