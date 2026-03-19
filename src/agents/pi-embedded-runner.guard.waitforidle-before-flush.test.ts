import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPendingToolResultsAfterIdle } from "./pi-embedded-runner/wait-for-idle-before-flush.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";

function assistantToolCall(id: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "exec", arguments: {} }],
    stopReason: "toolUse",
  } as AgentMessage;
}

function toolResult(id: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    content: [{ type: "text", text }],
    isError: false,
  } as AgentMessage;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function getMessages(sm: ReturnType<typeof guardSessionManager>): AgentMessage[] {
  return sm
    .getEntries()
    .filter((e) => e.type === "message")
    .map((e) => (e as { message: AgentMessage }).message);
}

describe("flushPendingToolResultsAfterIdle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for idle so real tool results can land before flush", async () => {
    const sm = guardSessionManager(SessionManager.inMemory());
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    const idle = deferred<void>();
    const agent = { waitForIdle: () => idle.promise };

    appendMessage(assistantToolCall("call_retry_1"));
    const flushPromise = flushPendingToolResultsAfterIdle({
      agent,
      sessionManager: sm,
      timeoutMs: 1_000,
    });

    // Flush is waiting for idle; synthetic result must not appear yet.
    await Promise.resolve();
    expect(getMessages(sm).map((m) => m.role)).toEqual(["assistant"]);

    // Tool completes before idle wait finishes.
    appendMessage(toolResult("call_retry_1", "command output here"));
    idle.resolve();
    await flushPromise;

    const messages = getMessages(sm);
    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
    expect((messages[1] as { isError?: boolean }).isError).not.toBe(true);
    expect((messages[1] as { content?: Array<{ text?: string }> }).content?.[0]?.text).toBe(
      "command output here",
    );
  });

  it("flushes pending tool call after timeout when idle never resolves", async () => {
    const sm = guardSessionManager(SessionManager.inMemory());
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    vi.useFakeTimers();
    const agent = { waitForIdle: () => new Promise<void>(() => {}) };

    appendMessage(assistantToolCall("call_orphan_1"));

    const flushPromise = flushPendingToolResultsAfterIdle({
      agent,
      sessionManager: sm,
      timeoutMs: 30,
    });
    await vi.advanceTimersByTimeAsync(30);
    await flushPromise;

    const entries = getMessages(sm);

    expect(entries.length).toBe(2);
    expect(entries[1].role).toBe("toolResult");
    expect((entries[1] as { isError?: boolean }).isError).toBe(true);
    expect((entries[1] as { content?: Array<{ text?: string }> }).content?.[0]?.text).toContain(
      "missing tool result",
    );
  });

  it("clears pending without synthetic flush when timeout cleanup is requested", async () => {
    const sm = guardSessionManager(SessionManager.inMemory());
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    vi.useFakeTimers();
    const agent = { waitForIdle: () => new Promise<void>(() => {}) };

    appendMessage(assistantToolCall("call_orphan_2"));

    const flushPromise = flushPendingToolResultsAfterIdle({
      agent,
      sessionManager: sm,
      timeoutMs: 30,
      clearPendingOnTimeout: true,
    });
    await vi.advanceTimersByTimeAsync(30);
    await flushPromise;

    expect(getMessages(sm).map((m) => m.role)).toEqual(["assistant"]);

    appendMessage({
      role: "user",
      content: "still there?",
      timestamp: Date.now(),
    } as AgentMessage);
    expect(getMessages(sm).map((m) => m.role)).toEqual(["assistant", "user"]);
  });

  it("detects pending tools via state.pendingToolCalls Set (pi-agent-core bridge)", async () => {
    const sm = guardSessionManager(SessionManager.inMemory());
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;

    // Simulate a pi-agent-core Agent that tracks pendingToolCalls as a Set on state.
    const pendingToolCalls = new Set<string>(["call_bridge_1"]);
    const secondIdle = deferred<void>();
    const waitForIdle = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => secondIdle.promise);

    // Bridge: same pattern as withPendingToolCallsHint in attempt.ts
    const agent = {
      waitForIdle,
      hasPendingToolCalls: () => pendingToolCalls.size > 0,
    };

    appendMessage(assistantToolCall("call_bridge_1"));

    const flushPromise = flushPendingToolResultsAfterIdle({
      agent,
      sessionManager: sm,
      timeoutMs: 5_000,
    });

    // Let microtasks settle.
    await new Promise<void>((r) => setTimeout(r, 50));

    // Simulate tool completion: clear the Set and deliver the result.
    pendingToolCalls.delete("call_bridge_1");
    appendMessage(toolResult("call_bridge_1", "bridged result"));
    secondIdle.resolve();
    await flushPromise;

    const messages = getMessages(sm);
    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
    expect((messages[1] as { isError?: boolean }).isError).not.toBe(true);
    expect((messages[1] as { content?: Array<{ text?: string }> }).content?.[0]?.text).toBe(
      "bridged result",
    );
  });

  it("re-waits across retry gap when hasPendingToolCalls returns true", async () => {
    const sm = guardSessionManager(SessionManager.inMemory());
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;

    // First idle resolves immediately, second resolves after tool completes.
    const secondIdle = deferred<void>();
    const waitForIdle = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined) // first call: resolves immediately (retry gap)
      .mockImplementationOnce(() => secondIdle.promise); // second call: waits for real idle

    // hasPendingToolCalls returns true on first check (tools still running after
    // idle resolved prematurely), then false once tools finish.
    const hasPendingToolCalls = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(true) // first check: still pending
      .mockReturnValueOnce(false); // second check: drained

    const agent = { waitForIdle, hasPendingToolCalls };

    appendMessage(assistantToolCall("call_retry_gap_1"));

    const flushPromise = flushPendingToolResultsAfterIdle({
      agent,
      sessionManager: sm,
      timeoutMs: 5_000,
    });

    // Let microtasks settle — first idle resolves, hasPendingToolCalls=true,
    // flush re-waits after 10ms tick.
    await vi.advanceTimersByTimeAsync?.(20).catch(() => {});
    await new Promise<void>((r) => setTimeout(r, 50));

    // Tool result arrives while flush is re-waiting.
    appendMessage(toolResult("call_retry_gap_1", "arrived after retry gap"));
    secondIdle.resolve();
    await flushPromise;

    const messages = getMessages(sm);
    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
    // The real tool result should be preserved, not a synthetic error.
    expect((messages[1] as { isError?: boolean }).isError).not.toBe(true);
    expect((messages[1] as { content?: Array<{ text?: string }> }).content?.[0]?.text).toBe(
      "arrived after retry gap",
    );
    expect(waitForIdle).toHaveBeenCalledTimes(2);
    expect(hasPendingToolCalls).toHaveBeenCalled();
  });

  it("clears timeout handle when waitForIdle resolves first", async () => {
    const sm = guardSessionManager(SessionManager.inMemory());
    vi.useFakeTimers();
    const agent = {
      waitForIdle: async () => {},
    };

    await flushPendingToolResultsAfterIdle({
      agent,
      sessionManager: sm,
      timeoutMs: 30_000,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
