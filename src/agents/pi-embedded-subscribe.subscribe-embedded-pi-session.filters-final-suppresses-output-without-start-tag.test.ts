import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createStubSessionHarness,
  emitAssistantTextDelta,
  emitMessageStartAndEndForAssistantText,
  extractAgentEventPayloads,
} from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

describe("subscribeEmbeddedPiSession", () => {
  it("filters to <final> and suppresses output without a start tag", () => {
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();
    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      enforceFinalTag: true,
      onPartialReply,
      onAgentEvent,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "<final>Hi there</final>" });

    expect(onPartialReply).toHaveBeenCalled();
    const firstPayload = onPartialReply.mock.calls[0][0];
    expect(firstPayload.text).toBe("Hi there");

    onPartialReply.mockClear();

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "</final>Oops no start" });

    expect(onPartialReply).not.toHaveBeenCalled();
  });
  it("suppresses agent events on message_end without <final> tags when enforced", () => {
    const { session, emit } = createStubSessionHarness();

    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      enforceFinalTag: true,
      onAgentEvent,
    });
    emitMessageStartAndEndForAssistantText({ emit, text: "Hello world" });
    // With enforceFinalTag, text without <final> tags is treated as leaked
    // reasoning and should NOT be recovered by the message_end fallback.
    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expect(payloads).toHaveLength(0);
  });
  it("emits via streaming when <final> tags are present and enforcement is on", () => {
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();
    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      enforceFinalTag: true,
      onPartialReply,
      onAgentEvent,
    });

    // With enforceFinalTag, content is emitted via streaming (text_delta path),
    // NOT recovered from message_end fallback. extractAssistantText strips
    // <final> tags, so message_end would see plain text with no <final> markers
    // and correctly suppress it (treated as reasoning leak).
    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "<final>Hello world</final>" });

    expect(onPartialReply).toHaveBeenCalled();
    expect(onPartialReply.mock.calls[0][0].text).toBe("Hello world");
  });
  it("ignores self-closing <final/> tags when enforcement is on", () => {
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      enforceFinalTag: true,
      onPartialReply,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: '<final type="done"/>hidden<final>Visible</final>' });

    expect(onPartialReply).toHaveBeenCalledTimes(1);
    expect(onPartialReply.mock.calls[0][0].text).toBe("Visible");
  });
  it("strips thinking tags with attributes without leaking their content", () => {
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      onPartialReply,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({
      emit,
      delta: '<think signature="gemini">hidden</think>Visible answer',
    });

    expect(onPartialReply).toHaveBeenCalledTimes(1);
    expect(onPartialReply.mock.calls[0][0].text).toBe("Visible answer");
  });
  it("does not require <final> when enforcement is off", () => {
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      onPartialReply,
    });

    emitAssistantTextDelta({ emit, delta: "Hello world" });

    const payload = onPartialReply.mock.calls[0][0];
    expect(payload.text).toBe("Hello world");
  });
  it("emits block replies on message_end", () => {
    const { session, emit } = createStubSessionHarness();

    const onBlockReply = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      onBlockReply,
      blockReplyBreak: "message_end",
    });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello block" }],
    } as AssistantMessage;

    emit({ type: "message_end", message: assistantMessage });

    expect(onBlockReply).toHaveBeenCalled();
    const payload = onBlockReply.mock.calls[0][0];
    expect(payload.text).toBe("Hello block");
  });
});
