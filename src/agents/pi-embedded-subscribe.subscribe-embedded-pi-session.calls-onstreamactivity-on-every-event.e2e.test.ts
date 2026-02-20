import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createStubSessionHarness } from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

describe("subscribeEmbeddedPiSession onStreamActivity", () => {
  it("fires onStreamActivity on every incoming event type", () => {
    const { session, emit } = createStubSessionHarness();

    const onStreamActivity = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run-activity",
      onStreamActivity,
    });

    const assistantMsg = {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
    } as AssistantMessage;

    emit({ type: "message_start", message: assistantMsg });
    emit({
      type: "message_update",
      message: assistantMsg,
      assistantMessageEvent: { type: "text_delta", delta: "hello" },
    });
    emit({ type: "message_end", message: assistantMsg });
    emit({
      type: "tool_execution_start",
      toolExecution: { id: "t1", toolName: "exec", args: "{}" },
    });
    emit({
      type: "tool_execution_update",
      toolExecution: { id: "t1", toolName: "exec" },
    });
    emit({
      type: "tool_execution_end",
      toolExecution: { id: "t1", toolName: "exec" },
    });

    // Every event fires onStreamActivity once.
    expect(onStreamActivity).toHaveBeenCalledTimes(6);
  });

  it("does not crash when onStreamActivity is omitted", () => {
    const { session, emit } = createStubSessionHarness();

    subscribeEmbeddedPiSession({
      session,
      runId: "run-no-activity",
    });

    const assistantMsg = {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
    } as AssistantMessage;

    // Should not throw even without the callback.
    expect(() => {
      emit({ type: "message_start", message: assistantMsg });
      emit({
        type: "message_update",
        message: assistantMsg,
        assistantMessageEvent: { type: "text_delta", delta: "x" },
      });
      emit({ type: "message_end", message: assistantMsg });
    }).not.toThrow();
  });

  it("resets activity on agent lifecycle events", () => {
    const { session, emit } = createStubSessionHarness();

    const onStreamActivity = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run-lifecycle",
      onStreamActivity,
    });

    emit({ type: "agent_start" });
    emit({ type: "agent_end" });

    expect(onStreamActivity).toHaveBeenCalledTimes(2);
  });
});
