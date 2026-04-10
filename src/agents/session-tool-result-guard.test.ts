import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import { castAgentMessage } from "./test-helpers/agent-message-fixtures.js";
import {
  consumePendingToolResultReplayMetadata,
  detectToolResultReplayPolicyMeta,
  drainPendingToolResultReplayMetadataForSession,
  recordPendingToolResultReplayMetadata,
} from "./tool-result-replay-metadata.js";

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

  it("tags persisted diagnostic exec tool results for replay policy", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm, { sessionKey: "agent:main:main" });

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
      }),
    );
    recordPendingToolResultReplayMetadata({
      sessionKey: "agent:main:main",
      toolCallId: "call_1",
      toolName: "exec",
      args: { command: "openclaw plugins list" },
    });
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "exec",
        content: [{ type: "text", text: "plugin output" }],
        isError: false,
        timestamp: Date.now(),
      }),
    );

    const messages = expectPersistedRoles(sm, ["assistant", "toolResult"]) as Array<
      AgentMessage & { __openclaw?: Record<string, unknown> }
    >;
    expect(messages[1]?.__openclaw?.transient).toBe(true);
    expect(messages[1]?.__openclaw?.diagnosticType).toBe("openclaw.plugins_list");
    expect(messages[1]?.__openclaw?.sourceTool).toBe("exec");
  });

  it("uses sessionId fallback when sessionKey is unavailable", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm, { sessionId: "session-only" });

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
      }),
    );
    recordPendingToolResultReplayMetadata({
      sessionId: "session-only",
      toolCallId: "call_1",
      toolName: "exec",
      args: { command: "openclaw status" },
    });
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "exec",
        content: [{ type: "text", text: "status output" }],
        isError: false,
        timestamp: Date.now(),
      }),
    );

    const messages = expectPersistedRoles(sm, ["assistant", "toolResult"]) as Array<
      AgentMessage & { __openclaw?: Record<string, unknown> }
    >;
    expect(messages[1]?.__openclaw?.transient).toBe(true);
    expect(messages[1]?.__openclaw?.diagnosticType).toBe("openclaw.status");
  });

  it("re-applies replay metadata after tool_result_persist transformations", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm, {
      sessionKey: "agent:main:main",
      transformToolResultForPersistence: (message) => {
        if (message.role !== "toolResult") {
          return message;
        }
        return {
          role: "toolResult",
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          content: message.content,
          isError: message.isError,
          timestamp: message.timestamp,
        } as AgentMessage;
      },
    });

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      }),
    );
    recordPendingToolResultReplayMetadata({
      sessionKey: "agent:main:main",
      toolCallId: "call_1",
      toolName: "read",
      args: { path: "/tmp/openclaw.json" },
    });
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: '{"ok":true}' }],
        isError: false,
        timestamp: Date.now(),
      }),
    );

    const messages = expectPersistedRoles(sm, ["assistant", "toolResult"]) as Array<
      AgentMessage & { __openclaw?: Record<string, unknown> }
    >;
    expect(messages[1]?.__openclaw?.transient).toBe(true);
    expect(messages[1]?.__openclaw?.diagnosticType).toBe("openclaw.config_snapshot");
    expect(messages[1]?.__openclaw?.sourceTool).toBe("read");
  });

  it("re-applies replay metadata after before_message_write rewrites", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm, {
      sessionKey: "agent:main:main",
      beforeMessageWriteHook: ({ message }) => {
        if (message.role !== "toolResult") {
          return undefined;
        }
        return {
          message: castAgentMessage({
            role: "toolResult",
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            content: message.content,
            isError: message.isError,
            timestamp: message.timestamp,
          }),
        };
      },
    });

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      }),
    );
    recordPendingToolResultReplayMetadata({
      sessionKey: "agent:main:main",
      toolCallId: "call_1",
      toolName: "read",
      args: { path: "/tmp/openclaw.json" },
    });
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: '{"ok":true}' }],
        isError: false,
        timestamp: Date.now(),
      }),
    );

    const messages = expectPersistedRoles(sm, ["assistant", "toolResult"]) as Array<
      AgentMessage & { __openclaw?: Record<string, unknown> }
    >;
    expect(messages[1]?.__openclaw?.transient).toBe(true);
    expect(messages[1]?.__openclaw?.diagnosticType).toBe("openclaw.config_snapshot");
  });

  it("stamps replay metadata with the persisted write time when toolResult timestamps are missing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T03:30:00.000Z"));

    try {
      const sm = SessionManager.inMemory();
      installSessionToolResultGuard(sm, { sessionKey: "agent:main:main" });

      sm.appendMessage(
        asAppendMessage({
          role: "assistant",
          content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
        }),
      );
      recordPendingToolResultReplayMetadata({
        sessionKey: "agent:main:main",
        toolCallId: "call_1",
        toolName: "exec",
        args: { command: "openclaw status" },
        taggedAt: Date.now() - 90_000,
      });
      sm.appendMessage(
        asAppendMessage({
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "exec",
          content: [{ type: "text", text: "status output" }],
          isError: false,
        }),
      );

      const messages = expectPersistedRoles(sm, ["assistant", "toolResult"]) as Array<
        AgentMessage & { __openclaw?: Record<string, unknown> }
      >;
      expect(messages[1]?.__openclaw?.persistedAt).toBe(Date.now());
      expect(messages[1]?.__openclaw?.taggedAt).toBe(Date.now() - 90_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains replay metadata when clearing pending tool calls", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm, { sessionKey: "agent:main:main" });

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
      }),
    );
    recordPendingToolResultReplayMetadata({
      sessionKey: "agent:main:main",
      toolCallId: "call_1",
      toolName: "exec",
      args: { command: "openclaw plugins list" },
    });

    guard.clearPendingToolResults();

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
      }),
    );
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "exec",
        content: [{ type: "text", text: "fresh output" }],
        isError: false,
        timestamp: Date.now(),
      }),
    );

    const messages = expectPersistedRoles(sm, ["assistant", "assistant", "toolResult"]) as Array<
      AgentMessage & { __openclaw?: Record<string, unknown> }
    >;
    expect(messages[2]?.__openclaw?.transient).not.toBe(true);
  });

  it("drains replay metadata when clearing with empty pending state", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm, {
      sessionKey: "agent:main:main",
      beforeMessageWriteHook: ({ message }) => {
        if ((message as { role?: unknown }).role !== "assistant") {
          return undefined;
        }
        const content = (message as { content?: unknown }).content;
        const hasToolCall =
          Array.isArray(content) &&
          content.some(
            (block) =>
              !!block &&
              typeof block === "object" &&
              ((block as { type?: unknown }).type === "toolCall" ||
                (block as { type?: unknown }).type === "toolUse"),
          );
        return hasToolCall ? { block: true } : undefined;
      },
    });

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
      }),
    );
    recordPendingToolResultReplayMetadata({
      sessionKey: "agent:main:main",
      toolCallId: "call_1",
      toolName: "exec",
      args: { command: "openclaw plugins list" },
    });

    // pendingState is empty because assistant tool-call persistence was blocked,
    // so clearPendingToolResults must still drain session replay metadata.
    guard.clearPendingToolResults();

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
      }),
    );
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "exec",
        content: [{ type: "text", text: "fresh output" }],
        isError: false,
        timestamp: Date.now(),
      }),
    );

    const messages = expectPersistedRoles(sm, ["toolResult"]) as Array<
      AgentMessage & { __openclaw?: Record<string, unknown> }
    >;
    expect(messages[0]?.__openclaw?.transient).not.toBe(true);
  });

  it("drains replay metadata by exact session key without prefix overreach", () => {
    recordPendingToolResultReplayMetadata({
      sessionKey: "agent:main",
      toolCallId: "call_1",
      toolName: "exec",
      args: { command: "openclaw status" },
    });
    recordPendingToolResultReplayMetadata({
      sessionKey: "agent:main:thread",
      toolCallId: "call_2",
      toolName: "exec",
      args: { command: "openclaw status" },
    });

    expect(
      consumePendingToolResultReplayMetadata({
        sessionKey: "agent:main:thread",
        toolCallId: "call_2",
      }),
    ).toMatchObject({ diagnosticType: "openclaw.status" });

    // Re-record thread entry, then drain only the base session.
    recordPendingToolResultReplayMetadata({
      sessionKey: "agent:main:thread",
      toolCallId: "call_2",
      toolName: "exec",
      args: { command: "openclaw status" },
    });

    expect(
      drainPendingToolResultReplayMetadataForSession({
        sessionKey: "agent:main",
      }),
    ).toBe(1);

    expect(
      consumePendingToolResultReplayMetadata({
        sessionKey: "agent:main",
        toolCallId: "call_1",
      }),
    ).toBeNull();
    expect(
      consumePendingToolResultReplayMetadata({
        sessionKey: "agent:main:thread",
        toolCallId: "call_2",
      }),
    ).toMatchObject({ diagnosticType: "openclaw.status" });
  });

  it("drains replay metadata when synthetic tool results are disabled", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm, {
      sessionKey: "agent:main:main",
      allowSyntheticToolResults: false,
    });

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
      }),
    );
    recordPendingToolResultReplayMetadata({
      sessionKey: "agent:main:main",
      toolCallId: "call_1",
      toolName: "exec",
      args: { command: "openclaw plugins list" },
    });

    sm.appendMessage(
      asAppendMessage({
        role: "user",
        content: "interrupt",
        timestamp: Date.now(),
      }),
    );

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
      }),
    );
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "exec",
        content: [{ type: "text", text: "fresh output" }],
        isError: false,
        timestamp: Date.now(),
      }),
    );

    const messages = expectPersistedRoles(sm, [
      "assistant",
      "user",
      "assistant",
      "toolResult",
    ]) as Array<AgentMessage & { __openclaw?: Record<string, unknown> }>;
    expect(guard.getPendingIds()).toEqual([]);
    expect(messages[3]?.__openclaw?.transient).not.toBe(true);
  });

  it("drains replay metadata even when flush runs with empty pending state", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm, {
      sessionKey: "agent:main:main",
      beforeMessageWriteHook: ({ message }) => {
        if ((message as { role?: unknown }).role !== "assistant") {
          return undefined;
        }
        const content = (message as { content?: unknown }).content;
        const hasToolCall =
          Array.isArray(content) &&
          content.some(
            (block) =>
              !!block &&
              typeof block === "object" &&
              ((block as { type?: unknown }).type === "toolCall" ||
                (block as { type?: unknown }).type === "toolUse"),
          );
        return hasToolCall ? { block: true } : undefined;
      },
    });

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
      }),
    );
    recordPendingToolResultReplayMetadata({
      sessionKey: "agent:main:main",
      toolCallId: "call_1",
      toolName: "exec",
      args: { command: "openclaw status" },
    });

    // Pending tool-call state is empty because assistant toolCall persistence was blocked,
    // but replay metadata should still be drained for the session.
    guard.flushPendingToolResults();

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
      }),
    );
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "exec",
        content: [{ type: "text", text: "fresh output" }],
        isError: false,
        timestamp: Date.now(),
      }),
    );

    const messages = expectPersistedRoles(sm, ["toolResult"]) as Array<
      AgentMessage & { __openclaw?: Record<string, unknown> }
    >;
    expect(messages[0]?.__openclaw?.transient).not.toBe(true);
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

  it("detects bundled plugin package probes as transient diagnostics", () => {
    expect(
      detectToolResultReplayPolicyMeta({
        toolName: "read",
        args: { path: "/repo/extensions/telegram/package.json" },
      }),
    ).toMatchObject({
      transient: true,
      diagnosticType: "openclaw.plugin_path_probe",
      sourceTool: "read",
    });
    expect(
      detectToolResultReplayPolicyMeta({
        toolName: "exec",
        args: { command: "cat extensions/telegram/package.json" },
      }),
    ).toMatchObject({
      transient: true,
      diagnosticType: "openclaw.plugin_path_probe",
      sourceTool: "exec",
    });
    expect(
      detectToolResultReplayPolicyMeta({
        toolName: "read",
        args: { path: "C:\\repo\\extensions\\telegram\\package.json" },
      }),
    ).toMatchObject({
      transient: true,
      diagnosticType: "openclaw.plugin_path_probe",
      sourceTool: "read",
    });
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
});
