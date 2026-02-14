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
    const idle = deferred<void>();
    const agent = { waitForIdle: () => idle.promise };

    sm.appendMessage(assistantToolCall("call_retry_1"));
    const flushPromise = flushPendingToolResultsAfterIdle({
      agent,
      sessionManager: sm,
      timeoutMs: 1_000,
    });

    // Flush is waiting for idle; synthetic result must not appear yet.
    await Promise.resolve();
    expect(getMessages(sm).map((m) => m.role)).toEqual(["assistant"]);

    // Tool completes before idle wait finishes.
    sm.appendMessage(toolResult("call_retry_1", "command output here"));
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
    vi.useFakeTimers();
    const agent = { waitForIdle: () => new Promise<void>(() => {}) };

    sm.appendMessage(assistantToolCall("call_orphan_1"));

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
