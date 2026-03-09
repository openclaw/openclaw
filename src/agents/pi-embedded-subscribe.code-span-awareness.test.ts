import { describe, expect, it, vi } from "vitest";
import {
  createStubSessionHarness,
  emitAssistantTextDelta,
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

  it("strips leaked tool transcript blocks from partial replies", () => {
    const { emit, onPartialReply } = createPartialReplyHarness();

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({
      emit,
      delta: `Before
<tool_call>
{"name":"subagents"}`,
    });
    emitAssistantTextDelta({
      emit,
      delta: `
</tool_call>
<tool_result>
Spawned sub-agent
</tool_result>
After`,
    });

    const texts = onPartialReply.mock.calls.map((call) => call[0]?.text);
    for (const text of texts) {
      expect(text).not.toContain("<tool_call>");
      expect(text).not.toContain("<tool_result>");
      expect(text).not.toContain("Spawned sub-agent");
    }
    expect(texts.at(-1)).toBe("Before\n\nAfter");
  });

  it("does not strip literal tool transcript tags inside fenced code blocks", () => {
    const { emit, onPartialReply } = createPartialReplyHarness();

    emitAssistantTextDelta({
      emit,
      delta: "Example:\n````xml\n<tool_call>\nliteral\n</tool_call>\n````",
    });

    expect(onPartialReply).toHaveBeenCalled();
    const lastCall = onPartialReply.mock.calls[onPartialReply.mock.calls.length - 1];
    expect(lastCall[0].text).toContain("<tool_call>");
    expect(lastCall[0].text).toContain("</tool_call>");
  });
});
