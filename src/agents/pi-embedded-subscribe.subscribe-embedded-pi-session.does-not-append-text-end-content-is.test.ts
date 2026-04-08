import { describe, expect, it, vi } from "vitest";
import {
  createTextEndBlockReplyHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./pi-embedded-subscribe.e2e-harness.js";

describe("subscribeEmbeddedPiSession", () => {
  function setupTextEndSubscription() {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    const emitDelta = (delta: string) => {
      emitAssistantTextDelta({ emit, delta });
    };

    const emitTextEnd = (content: string) => {
      emitAssistantTextEnd({ emit, content });
    };

    return { onBlockReply, subscription, emitDelta, emitTextEnd };
  }

  it.each([
    {
      name: "does not append when text_end content is an exact match of deltas",
      delta: "Hello world",
      content: "Hello world",
      expected: "Hello world",
    },
    {
      name: "does not append when text_end content is a prefix of deltas",
      delta: "Hello world",
      content: "Hello",
      expected: "Hello world",
    },
    {
      name: "does not append when text_end content is a suffix of deltas",
      delta: "Hello world",
      content: "world",
      expected: "Hello world",
    },
    {
      name: "does not append when text_end content is in the middle of deltas",
      delta: "Hello world, how are you",
      content: "world",
      expected: "Hello world, how are you",
    },
    {
      name: "appends suffix when text_end content strictly extends right side",
      delta: "Hello ",
      content: "Hello world",
      expected: "Hello world",
    },
    {
      name: "appends unique suffix when text_end content overlaps sufficiently (>= minOverlap=10)",
      delta: "This is a very long string ",
      content: "very long string and then some",
      expected: "This is a very long string and then some",
    },
    {
      name: "concatenates when text_end content overlap is purely coincidental (< minOverlap=10)",
      delta: "I ordered a bo",
      content: "ok with standard shipping",
      expected: "I ordered a book with standard shipping",
    },
    {
      name: "concatenates when text_end content has no overlap",
      delta: "Hello",
      content: "friend",
      expected: "Hellofriend",
    },
  ])("$name", async ({ delta, content, expected }) => {
    const { onBlockReply, subscription, emitDelta, emitTextEnd } = setupTextEndSubscription();

    emitDelta(delta);
    emitTextEnd(content);
    await Promise.resolve();

    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });
    expect(subscription.assistantTexts).toEqual([expected]);
  });
});
