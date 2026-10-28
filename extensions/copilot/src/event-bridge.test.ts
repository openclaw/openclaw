import { EventEmitter } from "node:events";
import type { SessionEvent } from "@github/copilot-sdk";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { buildAssistantMessage } from "./event-bridge-transcript.js";
import { attachEventBridge, type SessionLike } from "./event-bridge.js";
import { registerCopilotToolEventTests } from "./event-bridge.tools.test-support.js";

type EventData = Record<string, unknown>;
type EventMeta = Partial<SessionEvent>;

const MODEL_REF = {
  api: "openai-responses",
  id: "gpt-5",
  provider: "github-copilot",
} as const;
type FakeSession = SessionLike & {
  emit: (eventType: string, event: SessionEvent) => void;
  listenerCount: (eventType: string) => number;
};

function flushAsync() {
  const tick = () => Promise.resolve();
  return tick().then(tick);
}

function makeEvent(type: string, data: EventData, metadata: EventMeta = {}): SessionEvent {
  return {
    data,
    id: `${type}-id`,
    parentId: null,
    timestamp: "2024-01-01T00:00:00.000Z",
    type,
    ...metadata,
  } as SessionEvent;
}

function emit(session: FakeSession, type: string, data: EventData = {}, metadata: EventMeta = {}) {
  session.emit(type, makeEvent(type, data, metadata));
}

function planEvent(title: string, data: EventData) {
  return { stream: "plan", data: { phase: "update", source: "copilot-sdk", title, ...data } };
}

function expectedUsage(output: number, input = 0) {
  return {
    cacheRead: 0,
    cacheWrite: 0,
    input,
    output,
    totalTokens: output,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
  };
}

const makeAssistantMessageEvent = (
  content: string,
  overrides: EventData = {},
  metadata: EventMeta = {},
) =>
  makeEvent(
    "assistant.message",
    { content, messageId: "msg-1", model: "gpt-5", ...overrides },
    metadata,
  );

function createFakeSession(
  options: {
    onReturnedUnsubscribe?: (eventType: string) => void;
  } = {},
): FakeSession {
  const events = new EventEmitter();
  return {
    abort: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    emit: (type, event) => events.emit(type, event),
    id: "session-id",
    listenerCount: (type) => events.listenerCount(type),
    on: vi.fn((type: string, handler: (event: SessionEvent) => void) => {
      events.on(type, handler);
      return () => {
        options.onReturnedUnsubscribe?.(type);
        events.off(type, handler);
      };
    }),
    send: vi.fn().mockResolvedValue("sdk-user"),
    sendAndWait: vi.fn().mockResolvedValue(undefined),
    sessionId: "sdk-session-id",
  };
}

function attachTestBridge(
  session: SessionLike,
  options: Partial<Parameters<typeof attachEventBridge>[1]> = {},
) {
  return attachEventBridge(session, {
    getSdkSessionId: () => "sdk-session-id",
    isAborted: () => false,
    ...options,
  });
}

function setup(options: Partial<Parameters<typeof attachEventBridge>[1]> = {}) {
  const session = createFakeSession();
  const bridge = attachTestBridge(session, options);
  return {
    session,
    bridge,
    emit: (type: string, data: EventData = {}, metadata: EventMeta = {}) =>
      emit(session, type, data, metadata),
    assistant: (content: string, data: EventData = {}, metadata: EventMeta = {}) =>
      session.emit("assistant.message", makeAssistantMessageEvent(content, data, metadata)),
    message: (now = 9) => bridge.buildAssistantMessage({ modelRef: MODEL_REF, now: () => now }),
  };
}

function emitDelta(session: FakeSession, deltaContent: string, messageId: string) {
  emit(session, "assistant.message_delta", { deltaContent, messageId });
}

describe("attachEventBridge", () => {
  it("defaults missing usage fields to zero in the rich assistant block only", () => {
    expect(
      buildAssistantMessage({
        assistantTexts: [],
        modelRef: MODEL_REF,
        now: () => 9,
        usage: { input: 4 },
      }).usage,
    ).toEqual(expectedUsage(0, 4));
  });

  it("ignores child assistant and usage events but keeps child tool side effects", async () => {
    const onAssistantDelta = vi.fn();
    const onAgentEvent = vi.fn();
    const { session, bridge } = setup({ onAssistantDelta, onAgentEvent });

    emit(
      session,
      "assistant.message_delta",
      { deltaContent: "child", messageId: "child-msg" },
      { agentId: "child-1" },
    );
    emitDelta(session, "root", "root-msg");
    emit(
      session,
      "tool.execution_start",
      { toolCallId: "child-call", toolName: "write" },
      { agentId: "child-1" },
    );
    bridge.completeTool({ toolCallId: "child-call", toolName: "write", isError: false });
    bridge.completeTool({
      toolCallId: "child-nested",
      parentToolCallId: "child-call",
      toolName: "read",
      isError: false,
    });
    emit(
      session,
      "tool.execution_complete",
      {
        result: { content: "child write" },
        success: true,
        toolCallId: "child-call",
      },
      { agentId: "child-1" },
    );
    emit(session, "assistant.usage", { inputTokens: 99, outputTokens: 99 }, { agentId: "child-1" });

    expect(bridge.finalizeAssistantTexts()).toEqual(["root"]);
    const { startedCount, toolMetas } = bridge.snapshot();
    expect({ startedCount, toolMetas }).toEqual({
      startedCount: 0,
      toolMetas: [{ meta: "child write", toolName: "write", isError: false }],
    });
    expect(
      bridge.recordSendResult(makeAssistantMessageEvent("child final", {}, { agentId: "child-1" })),
    ).toBe(false);
    await bridge.awaitDeltaChain();
    await bridge.awaitAgentEventChain();
    expect(onAssistantDelta).toHaveBeenCalledTimes(1);
    expect(onAgentEvent.mock.calls.some(([event]) => event.stream === "item")).toBe(false);
  });

  it("interleaved messageIds produce two ordered assistantTexts entries", () => {
    const { session, bridge } = setup();

    emitDelta(session, "a", "msg-1");
    emitDelta(session, "x", "msg-2");
    emitDelta(session, "b", "msg-1");

    expect(bridge.finalizeAssistantTexts()).toEqual(["ab", "x"]);
  });

  it("ignored child and ephemeral users do not split a root assistant API call", () => {
    const { bridge, emit: send, assistant, message } = setup();
    assistant(
      "first",
      { apiCallId: "shared-call", messageId: "chunk-a" },
      { id: "assistant-chunk-a" },
    );
    send("user.message", { content: "child" }, { agentId: "child-1" });
    send("user.message", { content: "ephemeral" }, { ephemeral: true });
    assistant(
      "second",
      { apiCallId: "shared-call", messageId: "chunk-b" },
      { id: "assistant-chunk-b" },
    );
    bridge.flushTranscriptProjection();

    expect(message()?.content).toEqual([{ type: "text", text: "firstsecond" }]);
  });

  it("onAssistantDelta callbacks are serialized and awaitDeltaChain resolves after both", async () => {
    const order: string[] = [];
    const releases: Array<() => void> = [];
    const { session, bridge } = setup({
      onAssistantDelta: vi.fn(async (payload: { delta: string }) => {
        order.push(`start:${payload.delta}`);
        await new Promise<void>((resolve) => {
          releases.push(() => {
            order.push(`end:${payload.delta}`);
            resolve();
          });
        });
      }),
    });

    emitDelta(session, "a", "msg-1");
    emitDelta(session, "b", "msg-1");
    await flushAsync();

    expect(order).toEqual(["start:a"]);
    releases[0]?.();
    await flushAsync();
    expect(order).toEqual(["start:a", "end:a", "start:b"]);
    releases[1]?.();

    await expect(bridge.awaitDeltaChain()).resolves.toBeUndefined();
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  it("onAssistantDelta rejection propagates through awaitDeltaChain while later deltas still serialize", async () => {
    const order: string[] = [];
    const firstError = new Error("delta failed");
    const secondDeferred = createDeferred<void>();
    const { session, bridge } = setup({
      onAssistantDelta: vi.fn((payload: { delta: string }) => {
        order.push(`start:${payload.delta}`);
        if (payload.delta === "a") {
          return Promise.reject(firstError);
        }
        return secondDeferred.promise.then(() => {
          order.push(`end:${payload.delta}`);
        });
      }),
    });

    emitDelta(session, "a", "msg-1");
    emitDelta(session, "b", "msg-1");
    await flushAsync();
    await flushAsync();

    expect(order).toEqual(["start:a", "start:b"]);
    secondDeferred.resolve(undefined);

    await expect(bridge.awaitDeltaChain()).rejects.toBe(firstError);
    expect(order).toEqual(["start:a", "start:b", "end:b"]);
  });

  it("buildAssistantMessage prefers terminal reasoningText over reasoning deltas", () => {
    const { bridge, emit: send, message } = setup();
    send("assistant.reasoning_delta", { deltaContent: "older", reasoningId: "reason-1" });
    bridge.recordSendResult(
      makeAssistantMessageEvent("done", { reasoningText: "terminal reasoning" }),
    );

    expect(message(8)?.content).toEqual([
      { thinking: "terminal reasoning", type: "thinking" },
      { text: "done", type: "text" },
    ]);
  });

  it.each([
    ["longer", "short", "longer"],
    ["tiny", "longer text", "longer text"],
  ])("assistant.message reconciles delta %s with terminal %s", (delta, terminal, expected) => {
    const { session, bridge } = setup();
    emitDelta(session, delta, "msg-1");
    session.emit("assistant.message", makeAssistantMessageEvent(terminal));
    expect(bridge.finalizeAssistantTexts()).toEqual([expected]);
  });

  it("assistant.message with toolRequests produces toolCall content and toolUse stopReason", () => {
    const { bridge, message } = setup();

    bridge.recordSendResult(
      makeAssistantMessageEvent("call tool", {
        outputTokens: 7,
        toolRequests: [
          { arguments: { path: "README.md" }, name: "read_file", toolCallId: "call-1" },
        ],
      }),
    );

    expect(message()).toEqual({
      api: "openai-responses",
      content: [
        { text: "call tool", type: "text" },
        { arguments: { path: "README.md" }, id: "call-1", name: "read_file", type: "toolCall" },
      ],
      model: "gpt-5",
      provider: "github-copilot",
      role: "assistant",
      stopReason: "toolUse",
      timestamp: 9,
      usage: expectedUsage(7),
    });
  });

  it("projects Copilot plan events through the generic plan stream", async () => {
    const onAgentEvent = vi.fn().mockResolvedValue(undefined);
    const { bridge, emit: send } = setup({ onAgentEvent });
    send("session.plan_changed", { operation: "update" });
    send("exit_plan_mode.requested", {
      actions: ["approve", "edit"],
      planContent: "# Plan\n- inspect\n- patch",
      recommendedAction: "approve",
      requestId: "request-1",
      summary: "Plan ready",
    });
    send("exit_plan_mode.completed", {
      approved: true,
      requestId: "request-1",
      selectedAction: "approve",
    });

    await bridge.awaitAgentEventChain();

    expect(onAgentEvent.mock.calls).toEqual([
      [planEvent("Plan updated", { operation: "update" })],
      [
        planEvent("Plan updated", {
          explanation: "Plan ready",
          steps: ["# Plan", "inspect", "patch"].map((step) => ({ step, status: "pending" })),
          actions: ["approve", "edit"],
          requestId: "request-1",
          recommendedAction: "approve",
        }),
      ],
      [
        planEvent("Plan decision", {
          requestId: "request-1",
          approved: true,
          selectedAction: "approve",
        }),
      ],
    ]);
  });

  it("replaces prior usage and terminal token fallback with an invalid usage zero snapshot", () => {
    const { bridge, emit: send, message } = setup();

    bridge.recordSendResult(
      makeAssistantMessageEvent("done", { apiCallId: "usage-without-id", outputTokens: 7 }),
    );
    send("assistant.usage", { inputTokens: 5 });
    send("assistant.usage", {
      cacheReadTokens: "bad",
      cacheWriteTokens: Number.POSITIVE_INFINITY,
      inputTokens: undefined,
      outputTokens: Number.NaN,
    });

    expect(bridge.snapshot().usage).toEqual({
      cacheRead: undefined,
      cacheWrite: undefined,
      input: undefined,
      output: undefined,
      total: 0,
    });
    expect(message(9.5)?.usage).toEqual(expectedUsage(0));
  });

  registerCopilotToolEventTests({ createFakeSession, makeEvent });

  it("tool.execution_complete updates one tool meta per call and marks failures", () => {
    const { session, bridge } = setup();

    emit(session, "tool.execution_start", { toolCallId: "call-1", toolName: "bash" });
    emit(session, "tool.execution_complete", {
      result: { content: "content", detailedContent: "details" },
      success: true,
      toolCallId: "call-1",
    });
    emit(session, "tool.execution_start", { toolCallId: "call-2", toolName: "read" });
    emit(session, "tool.execution_complete", {
      error: { message: "failed" },
      success: false,
      toolCallId: "call-2",
    });

    expect(bridge.snapshot().toolMetas).toEqual([
      { meta: "details", toolName: "bash", isError: false },
      { meta: "failed", toolName: "read", isError: true },
    ]);
  });

  it("tool.execution_complete without a matching start increments completedCount without pushing meta", () => {
    const { session, bridge } = setup();

    emit(session, "tool.execution_complete", {
      result: { content: "done" },
      success: true,
      toolCallId: "missing",
    });

    const { completedCount, toolMetas } = bridge.snapshot();
    expect({ completedCount, toolMetas }).toEqual({ completedCount: 1, toolMetas: [] });
  });

  it("serializes compaction callbacks and clears active compaction state on completion", async () => {
    const calls: string[] = [];
    const { session, bridge } = setup({
      onCompactionStart: () => {
        calls.push("start");
      },
      onCompactionComplete: ({ success }) => {
        calls.push(`complete:${success}`);
      },
    });

    emit(session, "session.compaction_start", {});
    emit(session, "session.compaction_complete", { success: false });
    emit(session, "session.compaction_start", {});
    emit(session, "session.compaction_complete", { success: true });
    await bridge.awaitCompactionChain();

    expect(calls).toEqual(["start", "complete:false", "start", "complete:true"]);
    expect(bridge.isCompacting()).toBe(false);
  });

  it("invalidates shared tool context for child compaction without tracking it as root", async () => {
    const onContextCompacted = vi.fn();
    const onCompactionStart = vi.fn();
    const onCompactionComplete = vi.fn();
    const { session, bridge } = setup({
      onContextCompacted,
      onCompactionStart,
      onCompactionComplete,
    });

    emit(session, "session.compaction_complete", { success: false });
    expect(onContextCompacted).not.toHaveBeenCalled();

    emit(session, "session.compaction_complete", { success: true });
    expect(onContextCompacted).toHaveBeenCalledTimes(1);
    await bridge.awaitCompactionCompletion();
    onCompactionComplete.mockClear();

    emit(session, "session.compaction_start", {}, { agentId: "subagent-1" });
    emit(session, "session.compaction_complete", { success: true }, { agentId: "subagent-1" });
    expect(onContextCompacted).toHaveBeenCalledTimes(2);
    expect(bridge.hasObservedCompaction()).toBe(false);
    expect(bridge.isCompacting()).toBe(false);
    expect(onCompactionStart).not.toHaveBeenCalled();
    await bridge.awaitCompactionCompletion();
    expect(onCompactionComplete).not.toHaveBeenCalled();
  });

  it.each(["completion", "abort", "teardown"] as const)(
    "settles compaction after %s",
    async (mode) => {
      const complete = vi.fn();
      const { session, bridge } = setup(
        mode === "completion" ? { onCompactionComplete: complete } : {},
      );
      emit(session, "session.compaction_start", {});
      const completion = bridge.awaitCompactionCompletion();
      if (mode === "completion") {
        await flushAsync();
        expect(bridge.hasObservedCompaction()).toBe(true);
        expect(complete).not.toHaveBeenCalled();
        emit(session, "session.compaction_complete", { messagesRemoved: 3, success: true });
      } else if (mode === "abort") {
        emit(session, "abort", { reason: "tool yield" });
        await flushAsync();
        expect(bridge.isCompacting()).toBe(true);
        emit(session, "session.compaction_complete", { success: false });
      } else {
        bridge.settleCompactionWait();
      }
      await completion;
      if (mode === "completion") {
        expect(complete).toHaveBeenCalledWith({ messagesRemoved: 3, success: true });
      }
      expect(bridge.isCompacting()).toBe(false);
    },
  );

  it("ignores subagent idle events while waiting for the root session", async () => {
    const { session, bridge } = setup();

    const idle = bridge.awaitSessionIdle();
    emit(session, "session.idle", {}, { agentId: "subagent-1" });
    await flushAsync();
    expect(bridge.hasObservedSessionIdle()).toBe(false);

    emit(session, "session.idle", {});
    await idle;
    expect(bridge.hasObservedSessionIdle()).toBe(true);
  });

  it.each([false, true])("records session.error only when aborted=%s is false", (aborted) => {
    const { session, bridge } = setup({ isAborted: () => aborted });
    emit(
      session,
      "session.error",
      aborted
        ? { errorType: "ignored", message: "ignored" }
        : { errorCode: "boom_code", errorType: "boom_type", message: "boom" },
    );
    if (aborted) {
      expect(bridge.snapshot().streamError).toBeUndefined();
    } else {
      expect(bridge.snapshot().streamError).toMatchObject({ code: "boom_code", message: "boom" });
    }
  });

  it("ignores empty assistant and reasoning deltas", () => {
    const onAssistantDelta = vi.fn();
    const { session, bridge, assistant, message } = setup({ onAssistantDelta });
    expect(message(13)).toBeUndefined();

    emitDelta(session, "", "msg-1");
    emit(session, "assistant.reasoning_delta", { deltaContent: "", reasoningId: "reason-1" });
    assistant("", { messageId: "msg-1" });

    expect(onAssistantDelta).not.toHaveBeenCalled();
    expect(bridge.finalizeAssistantTexts()).toEqual([]);
    expect(message(13)).toBeUndefined();
  });

  it.each([false, true])("detaches once in reverse order even with throwing=%s", (throws) => {
    const order: string[] = [];
    const session = createFakeSession({
      onReturnedUnsubscribe: (eventType) => {
        order.push(eventType);
        if (throws && eventType === "session.error") {
          throw new Error("unsubscribe failed");
        }
      },
    });
    const bridge = attachTestBridge(session);
    const registeredEvents = vi.mocked(session.on).mock.calls.map(([eventType]) => eventType);
    bridge.detach();
    bridge.detach();
    emitDelta(session, "ignored", "msg-1");
    expect(order).toEqual(registeredEvents.toReversed());
    expect(session.listenerCount("assistant.message_delta")).toBe(0);
  });
});
