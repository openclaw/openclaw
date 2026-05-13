import { describe, expect, it, vi } from "vitest";
import type { AgentRunEvent } from "../runtime-backend.js";
import { forwardAgentRunEventToAttemptCallbacks } from "./run-event-bridge.js";
import type { AgentHarnessAttemptParams } from "./types.js";

function createParams(
  overrides: Partial<AgentHarnessAttemptParams> = {},
): AgentHarnessAttemptParams {
  return {
    sessionId: "session-bridge",
    sessionKey: "agent:main:thread",
    workspaceDir: "/tmp/workspace",
    prompt: "hello",
    timeoutMs: 1000,
    runId: "run-bridge",
    provider: "openai",
    modelId: "gpt-5.5",
    thinkLevel: "medium",
    authStorage: undefined,
    authProfileStore: undefined,
    modelRegistry: undefined,
    model: undefined,
    ...overrides,
  } as AgentHarnessAttemptParams;
}

function createEvent(data: Record<string, unknown>, stream = "lifecycle"): AgentRunEvent {
  return {
    runId: "run-bridge",
    stream,
    data,
    sessionKey: "agent:main:thread",
  };
}

describe("agent run event bridge", () => {
  it("forwards generic worker events to the parent onAgentEvent callback", async () => {
    const onAgentEvent = vi.fn();
    await forwardAgentRunEventToAttemptCallbacks(
      createParams({ onAgentEvent }),
      createEvent({ phase: "started" }),
    );

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: { phase: "started" },
      sessionKey: "agent:main:thread",
    });
  });

  it("maps worker callback events to streaming reply callbacks", async () => {
    const onPartialReply = vi.fn();
    const onBlockReply = vi.fn();
    const onToolResult = vi.fn();
    const params = createParams({ onPartialReply, onBlockReply, onToolResult });

    await forwardAgentRunEventToAttemptCallbacks(
      params,
      createEvent({ callback: "partial_reply", payload: { text: "draft" } }, "final"),
    );
    await forwardAgentRunEventToAttemptCallbacks(
      params,
      createEvent({ callback: "block_reply", payload: { text: "visible" } }, "final"),
    );
    await forwardAgentRunEventToAttemptCallbacks(
      params,
      createEvent({ callback: "tool_result", payload: { text: "tool" } }, "tool"),
    );

    expect(onPartialReply).toHaveBeenCalledWith({ text: "draft" });
    expect(onBlockReply).toHaveBeenCalledWith({ text: "visible" });
    expect(onToolResult).toHaveBeenCalledWith({ text: "tool" });
  });

  it("keeps parent-owned refs and one-shot callbacks out of the worker payload", async () => {
    const onExecutionStarted = vi.fn();
    const onUserMessagePersisted = vi.fn();
    const hasRepliedRef = { value: false };
    const params = createParams({ hasRepliedRef, onExecutionStarted, onUserMessagePersisted });

    await forwardAgentRunEventToAttemptCallbacks(
      params,
      createEvent({ callback: "execution_started" }),
    );
    await forwardAgentRunEventToAttemptCallbacks(
      params,
      createEvent({ callback: "has_replied", value: true }),
    );
    await forwardAgentRunEventToAttemptCallbacks(
      params,
      createEvent({
        callback: "user_message_persisted",
        payload: { role: "user", content: "hello", timestamp: 123 },
      }),
    );

    expect(onExecutionStarted).toHaveBeenCalledTimes(1);
    expect(hasRepliedRef.value).toBe(true);
    expect(onUserMessagePersisted).toHaveBeenCalledWith({
      role: "user",
      content: "hello",
      timestamp: 123,
    });
  });
});
