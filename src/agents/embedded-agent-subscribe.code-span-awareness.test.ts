// Code-span awareness tests ensure streamed thinking-tag stripping ignores
// literal examples inside inline and fenced code.
import { describe, expect, it, vi } from "vitest";
import {
  createStubSessionHarness,
  emitAssistantTextDelta,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";

describe("subscribeEmbeddedAgentSession thinking tag code span awareness", () => {
  function createPartialReplyHarness() {
    // Partial replies are the earliest user-visible stream path, so this
    // harness isolates tag stripping before terminal message handling.
    const { session, emit } = createStubSessionHarness();
    const onPartialReply = vi.fn();

    subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      onPartialReply,
    });

    return { emit, onPartialReply };
  }

  it.each([
    {
      name: "does not strip thinking tags inside inline code backticks",
      input: "The fix strips leaked `<thinking>` tags from messages.",
      expected: "The fix strips leaked `<thinking>` tags from messages.",
    },
    {
      name: "does not strip thinking tags inside fenced code blocks",
      input: "Example:\n  ````\n<thinking>code example</thinking>\n  ````\nDone.",
      expected: "Example:\n  ````\n<thinking>code example</thinking>\n  ````\nDone.",
    },
    {
      name: "still strips actual thinking tags outside code spans",
      input: "Hello <thinking>internal thought</thinking> world",
      expected: "Hello  world",
    },
  ])("$name", ({ input, expected }) => {
    const { emit, onPartialReply } = createPartialReplyHarness();
    emitAssistantTextDelta({ emit, delta: input });
    expect(onPartialReply).toHaveBeenCalledTimes(1);
    expect(onPartialReply).toHaveBeenCalledWith({
      text: expected,
      delta: expected,
      replace: undefined,
      mediaUrls: undefined,
      phase: undefined,
    });
  });
});
