import { describe, expect, it, vi } from "vitest";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type StubSession = {
  subscribe: (fn: (evt: unknown) => void) => () => void;
};

describe("subscribeEmbeddedPiSession", () => {
  function setupTextEndSubscription() {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onBlockReply = vi.fn();

    const subscription = subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
    });

    const emit = (evt: unknown) => handler?.(evt);

    const emitDelta = (delta: string) => {
      emit({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "text_delta",
          delta,
        },
      });
    };

    const emitTextEnd = (content: string) => {
      emit({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "text_end",
          content,
        },
      });
    };

    return { onBlockReply, subscription, emitDelta, emitTextEnd };
  }

  it.each([
    {
      name: "does not append when text_end content is a prefix of deltas",
      delta: "Hello world",
      content: "Hello",
      expected: "Hello world",
    },
    {
      name: "does not append when text_end content is already contained",
      delta: "Hello world",
      content: "world",
      expected: "Hello world",
    },
    {
      name: "appends suffix when text_end content extends deltas",
      delta: "Hello",
      content: "Hello world",
      expected: "Hello world",
    },
  ])("$name", ({ delta, content, expected }) => {
    const { onBlockReply, subscription, emitDelta, emitTextEnd } = setupTextEndSubscription();

    emitDelta(delta);
    emitTextEnd(content);

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual([expected]);
  });
});
