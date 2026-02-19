import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
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

    const entries = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(entries.map((m) => m.role)).toEqual(["assistant", "toolResult", "assistant"]);
    const synthetic = entries[1] as {
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

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
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

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
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

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(messages.map((m) => m.role)).toEqual([
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

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);
    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
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

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(messages).toHaveLength(0);
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

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
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
});
