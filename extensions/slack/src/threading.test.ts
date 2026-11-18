// Slack tests cover threading plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveSlackThreadContext } from "./threading.js";

describe("resolveSlackThreadContext", () => {
  function expectAutoCreatedTopLevelThreadTsBehavior(replyToMode: "off" | "first" | "batched") {
    const { messageThreadId, isThreadReply } = resolveSlackThreadContext({
      replyToMode,
      message: {
        type: "message",
        channel: "C1",
        ts: "123",
        thread_ts: "123",
      },
    });

    expect(isThreadReply).toBe(false);
    expect(messageThreadId).toBeUndefined();
  }

  it("threads replies when message is already threaded", () => {
    const context = resolveSlackThreadContext({
      replyToMode: "off",
      message: {
        type: "message",
        channel: "C1",
        ts: "123",
        thread_ts: "456",
      },
    });

    expect(context).toMatchObject({
      isThreadReply: true,
      messageThreadId: "456",
      replyToId: "456",
    });
  });

  it("threads top-level replies when mode is all", () => {
    const context = resolveSlackThreadContext({
      replyToMode: "all",
      message: {
        type: "message",
        channel: "C1",
        ts: "123",
      },
    });

    expect(context.isThreadReply).toBe(false);
    expect(context.messageThreadId).toBe("123");
    expect(context.replyToId).toBeUndefined();
  });

  it("does not treat auto-created top-level thread_ts as a real thread when mode is off", () => {
    expectAutoCreatedTopLevelThreadTsBehavior("off");
  });

  it("uses normalized direct-message state for DM assistant thread-root messages", () => {
    for (const channelType of ["channel", undefined] as const) {
      const message = {
        type: "message",
        channel: "D1",
        ts: "123",
        thread_ts: "123",
        ...(channelType ? { channel_type: channelType } : {}),
      } as const;

      const context = resolveSlackThreadContext({
        replyToMode: "off",
        isDirectMessage: true,
        message,
      });

      expect(context.isThreadReply).toBe(false);
      expect(context.messageThreadId).toBe("123");
      expect(context.replyToId).toBeUndefined();
    }
  });
});
