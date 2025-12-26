import { describe, expect, it, vi } from "vitest";

import type { AssistantMessage } from "@mariozechner/pi-ai";

import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type StubSession = {
  subscribe: (fn: (evt: unknown) => void) => () => void;
};

describe("subscribeEmbeddedPiSession", () => {
  it("filters to <final> and falls back when tags are malformed", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onPartialReply = vi.fn();
    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<
        typeof subscribeEmbeddedPiSession
      >[0]["session"],
      runId: "run",
      enforceFinalTag: true,
      onPartialReply,
      onAgentEvent,
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "<final>Hi there</final>",
      },
    });

    expect(onPartialReply).toHaveBeenCalled();
    const firstPayload = onPartialReply.mock.calls[0][0];
    expect(firstPayload.text).toBe("Hi there");

    onPartialReply.mockReset();

    handler?.({
      type: "message_end",
      message: { role: "assistant" },
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "</final>Oops no start",
      },
    });

    const secondPayload = onPartialReply.mock.calls[0][0];
    expect(secondPayload.text).toContain("Oops no start");
  });

  it("does not require <final> when enforcement is off", () => {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onPartialReply = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<
        typeof subscribeEmbeddedPiSession
      >[0]["session"],
      runId: "run",
      onPartialReply,
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Hello world",
      },
    });

    const payload = onPartialReply.mock.calls[0][0];
    expect(payload.text).toBe("Hello world");
  });

  it("waits for auto-compaction retry and clears buffered text", async () => {
    const listeners: Array<(evt: any) => void> = [];
    const session = {
      subscribe: (listener: (evt: any) => void) => {
        listeners.push(listener);
        return () => {
          const index = listeners.indexOf(listener);
          if (index !== -1) listeners.splice(index, 1);
        };
      },
    } as any;

    const subscription = subscribeEmbeddedPiSession({
      session,
      runId: "run-1",
    });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "oops" }],
    } as AssistantMessage;

    for (const listener of listeners) {
      listener({ type: "message_end", message: assistantMessage });
    }

    expect(subscription.assistantTexts.length).toBe(1);

    for (const listener of listeners) {
      listener({
        type: "auto_compaction_end",
        willRetry: true,
      });
    }

    expect(subscription.assistantTexts.length).toBe(0);

    let resolved = false;
    const waitPromise = subscription.waitForCompactionRetry().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    for (const listener of listeners) {
      listener({ type: "agent_end" });
    }

    await waitPromise;
    expect(resolved).toBe(true);
  });
});
