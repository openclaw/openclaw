import { describe, expect, it, vi } from "vitest";
import {
  createStubSessionHarness,
  emitAssistantTextDelta,
  emitMessageStartAndEndForAssistantText,
  extractAgentEventPayloads,
} from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

describe("subscribeEmbeddedPiSession thinking tag code span awareness", () => {
  function createPartialReplyHarness() {
    const { session, emit } = createStubSessionHarness();
    const onPartialReply = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      onPartialReply,
    });

    return { emit, onPartialReply };
  }

  it("does not strip thinking tags inside inline code backticks", () => {
    const { emit, onPartialReply } = createPartialReplyHarness();

    emitAssistantTextDelta({
      emit,
      delta: "The fix strips leaked `<thinking>` tags from messages.",
    });

    expect(onPartialReply).toHaveBeenCalled();
    const lastCall = onPartialReply.mock.calls[onPartialReply.mock.calls.length - 1];
    expect(lastCall[0].text).toContain("`<thinking>`");
  });

  it("does not strip thinking tags inside fenced code blocks", () => {
    const { emit, onPartialReply } = createPartialReplyHarness();

    emitAssistantTextDelta({
      emit,
      delta: "Example:\n  ````\n<thinking>code example</thinking>\n  ````\nDone.",
    });

    expect(onPartialReply).toHaveBeenCalled();
    const lastCall = onPartialReply.mock.calls[onPartialReply.mock.calls.length - 1];
    expect(lastCall[0].text).toContain("<thinking>code example</thinking>");
  });

  it("still strips actual thinking tags outside code spans", () => {
    const { emit, onPartialReply } = createPartialReplyHarness();

    emitAssistantTextDelta({
      emit,
      delta: "Hello <thinking>internal thought</thinking> world",
    });

    expect(onPartialReply).toHaveBeenCalled();
    const lastCall = onPartialReply.mock.calls[onPartialReply.mock.calls.length - 1];
    expect(lastCall[0].text).not.toContain("internal thought");
    expect(lastCall[0].text).toContain("Hello");
    expect(lastCall[0].text).toContain("world");
  });

  it("strips thinking in message_end fallback path so reasoning does not leak", () => {
    const { session, emit } = createStubSessionHarness();
    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      onAgentEvent,
    });
    // No text_delta: only message_start + message_end, so we hit the fallback path.
    emitMessageStartAndEndForAssistantText({
      emit,
      text: "<thinking>internal reasoning</thinking>Hello world",
    });

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("Hello world");
    expect(payloads[0]?.text).not.toContain("internal reasoning");
  });
});
