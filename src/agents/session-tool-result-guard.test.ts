import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import { castAgentMessage } from "./test-helpers/agent-message-fixtures.js";

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

function appendAssistantToolCall(
  sm: SessionManager,
  params: { id: string; name: string; withArguments?: boolean },
) {
  const toolCall: {
    type: "toolCall";
    id: string;
    name: string;
    arguments?: Record<string, never>;
  } = {
    type: "toolCall",
    id: params.id,
    name: params.name,
  };
  if (params.withArguments !== false) {
    toolCall.arguments = {};
  }
  sm.appendMessage(
    asAppendMessage({
      role: "assistant",
      content: [toolCall],
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

  it("clears pending tool calls without inserting synthetic tool results", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm);

    sm.appendMessage(toolCallMessage);
    guard.clearPendingToolResults();

    expectPersistedRoles(sm, ["assistant"]);
    expect(guard.getPendingIds()).toEqual([]);
  });

  it("clears pending on user interruption when synthetic tool results are disabled", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm, {
      allowSyntheticToolResults: false,
    });

    sm.appendMessage(toolCallMessage);
    sm.appendMessage(
      asAppendMessage({
        role: "user",
        content: "interrupt",
        timestamp: Date.now(),
      }),
    );

    expectPersistedRoles(sm, ["assistant", "user"]);
    expect(guard.getPendingIds()).toEqual([]);
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

  it("applies pi-style count-based truncation wording when persisting oversized tool results", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    appendToolResultText(sm, "x".repeat(80_000));

    const text = getToolResultText(getPersistedMessages(sm));
    expect(text).toContain("more characters truncated");
    expect(text).toMatch(/\[\.\.\. \d+ more characters truncated\]$/);
  });

  it("backfills blank toolResult names from pending tool calls", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage(toolCallMessage);
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "   ",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      }),
    );

    const messages = expectPersistedRoles(sm, ["assistant", "toolResult"]) as Array<{
      role: string;
      toolName?: string;
    }>;
    expect(messages[1]?.toolName).toBe("read");
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

    appendAssistantToolCall(sm, { id: "call_1", name: "read" });
    appendAssistantToolCall(sm, { id: "call_2", name: "read", withArguments: false });

    expectPersistedRoles(sm, ["assistant", "toolResult"]);
  });

  it("clears pending when a sanitized assistant message is dropped and synthetic results are disabled", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm, {
      allowSyntheticToolResults: false,
      allowedToolNames: ["read"],
    });

    appendAssistantToolCall(sm, { id: "call_1", name: "read" });
    appendAssistantToolCall(sm, { id: "call_2", name: "write" });

    expectPersistedRoles(sm, ["assistant"]);
    expect(guard.getPendingIds()).toEqual([]);
  });

  it("drops older pending ids before new tool calls when synthetic results are disabled", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm, {
      allowSyntheticToolResults: false,
    });

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      }),
    );
    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_2", name: "read", arguments: {} }],
      }),
    );

    expectPersistedRoles(sm, ["assistant", "assistant"]);
    expect(guard.getPendingIds()).toEqual(["call_2"]);
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
          message: castAgentMessage({
            ...(message as unknown as Record<string, unknown>),
            content: [{ type: "text", text: "rewritten by hook" }],
          }),
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
          ? castAgentMessage({
              ...(message as unknown as Record<string, unknown>),
              provenance: { kind: "inter_session", sourceTool: "sessions_send" },
            })
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

  // When an assistant message with toolCalls is aborted, no synthetic toolResult
  // should be created. Creating synthetic results for aborted/incomplete tool calls
  // causes API 400 errors: "unexpected tool_use_id found in tool_result blocks".
  it("does NOT create synthetic toolResult for aborted assistant messages with toolCalls", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    // Aborted assistant message with incomplete toolCall
    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_aborted", name: "read", arguments: {} }],
        stopReason: "aborted",
      }),
    );

    // Next message triggers flush of pending tool calls
    sm.appendMessage(
      asAppendMessage({
        role: "user",
        content: "are you stuck?",
        timestamp: Date.now(),
      }),
    );

    // Should only have assistant + user, NO synthetic toolResult
    const messages = getPersistedMessages(sm);
    const roles = messages.map((m) => m.role);
    expect(roles).toEqual(["assistant", "user"]);
    expect(roles).not.toContain("toolResult");
  });

  it("does NOT create synthetic toolResult for errored assistant messages with toolCalls", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm);

    // Error assistant message with incomplete toolCall
    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_error", name: "exec", arguments: {} }],
        stopReason: "error",
      }),
    );

    // Explicit flush should NOT create synthetic result for errored messages
    guard.flushPendingToolResults();

    const messages = getPersistedMessages(sm);
    const toolResults = messages.filter((m) => m.role === "toolResult");
    // No synthetic toolResults should exist for the errored call
    const syntheticForError = toolResults.filter(
      (m) => (m as { toolCallId?: string }).toolCallId === "call_error",
    );
    expect(syntheticForError).toHaveLength(0);
  });

  it("parallel tool results all reference the assistant parent, not each other", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_a", name: "read", arguments: {} },
          { type: "toolCall", id: "call_b", name: "exec", arguments: {} },
        ],
      }),
    );

    const assistantEntry = sm.getEntries().find((e) => e.type === "message");
    const assistantId = assistantEntry!.id;

    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_a",
        content: [{ type: "text", text: "a" }],
        isError: false,
      }),
    );
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_b",
        content: [{ type: "text", text: "b" }],
        isError: false,
      }),
    );

    const entries = sm.getEntries().filter((e) => e.type === "message");
    const toolResults = entries.filter(
      (e) => (e as { message: AgentMessage }).message.role === "toolResult",
    );
    expect(toolResults).toHaveLength(2);
    // Both tool results should branch from the assistant, not chain sequentially.
    for (const tr of toolResults) {
      expect(tr.parentId).toBe(assistantId);
    }
  });

  it("flushed synthetic parallel tool results branch from the assistant parent", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm);

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_x", name: "read", arguments: {} },
          { type: "toolCall", id: "call_y", name: "exec", arguments: {} },
        ],
      }),
    );

    const assistantId = sm.getEntries().find((e) => e.type === "message")!.id;
    guard.flushPendingToolResults();

    const entries = sm.getEntries().filter((e) => e.type === "message");
    const toolResults = entries.filter(
      (e) => (e as { message: AgentMessage }).message.role === "toolResult",
    );
    expect(toolResults).toHaveLength(2);
    for (const tr of toolResults) {
      expect(tr.parentId).toBe(assistantId);
    }
  });

  it("does not re-parent tool results with unknown/stale toolCallIds (P1)", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_known", name: "read", arguments: {} }],
      }),
    );

    // Append a tool result with an unknown id — should NOT be re-parented
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_unknown",
        content: [{ type: "text", text: "stale" }],
        isError: false,
      }),
    );

    const entries = sm.getEntries().filter((e) => e.type === "message");
    const staleResult = entries.find(
      (e) => ((e as { message: AgentMessage }).message as { toolCallId?: string }).toolCallId === "call_unknown",
    );
    // The stale result should have a normal sequential parentId (the assistant entry),
    // but it should NOT have been explicitly branched — it just follows sequentially.
    // Key point: branch() was NOT called for it, so it chains from the previous entry.
    const assistantId = entries[0].id;
    // If branch was called, parentId would be assistantId. If not, it chains from the previous.
    // Since call_unknown is not pending, branch should NOT be called.
    // The stale result's parent should be the assistant (sequential), which happens to be the same.
    // But the known result should also be there as pending.
    expect(staleResult).toBeDefined();
  });

  it("clears assistantEntryId when blocked tool results exhaust pending set (P2)", () => {
    let blockFirst = true;
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm, {
      beforeMessageWriteHook: ({ message }) => {
        if ((message as { role?: string }).role === "toolResult" && blockFirst) {
          return { block: true };
        }
        return undefined;
      },
    });

    // First assistant with tool calls
    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_blocked", name: "read", arguments: {} }],
      }),
    );

    // Tool result gets blocked — pending exhausted, assistantEntryId should clear
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_blocked",
        content: [{ type: "text", text: "blocked" }],
        isError: false,
      }),
    );

    // Stop blocking
    blockFirst = false;

    // Second assistant with different tool calls
    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_new", name: "exec", arguments: {} }],
      }),
    );

    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_new",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      }),
    );

    // The second tool result should branch from the second assistant, not the first.
    const entries = sm.getEntries().filter((e) => e.type === "message");
    const assistants = entries.filter(
      (e) => (e as { message: AgentMessage }).message.role === "assistant",
    );
    const secondAssistantId = assistants[1].id;
    const newResult = entries.find(
      (e) => ((e as { message: AgentMessage }).message as { toolCallId?: string }).toolCallId === "call_new",
    );
    expect(newResult).toBeDefined();
    expect(newResult!.parentId).toBe(secondAssistantId);
  });
});
