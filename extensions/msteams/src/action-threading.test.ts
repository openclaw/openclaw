import { describe, expect, it } from "vitest";
import { resolveMSTeamsAutoThreadId } from "./action-threading.js";

describe("resolveMSTeamsAutoThreadId", () => {
  const sameChannel = {
    currentChannelId: "conversation:19:channel@thread.tacv2",
    currentThreadTs: "thread-root",
    replyToMode: "all" as const,
  };

  it("returns ambient thread root for matching Graph messaging target", () => {
    expect(
      resolveMSTeamsAutoThreadId({
        to: "team-1/19:channel@thread.tacv2",
        toolContext: {
          currentMessagingTarget: "team-1/19:channel@thread.tacv2",
          currentThreadTs: "thread-root",
          replyToMode: "all",
        },
      }),
    ).toBe("thread-root");
  });

  it("preserves an explicit message id without ambient tool context", () => {
    expect(
      resolveMSTeamsAutoThreadId({
        to: "conversation:19:channel@thread.tacv2;messageid=explicit-root",
      }),
    ).toBe("explicit-root");
  });

  it("returns undefined when replyToMode is off", () => {
    expect(
      resolveMSTeamsAutoThreadId({
        to: "conversation:19:channel@thread.tacv2",
        toolContext: { ...sameChannel, replyToMode: "off" },
      }),
    ).toBeUndefined();
  });

  it("returns undefined after a single-use reply when already replied", () => {
    expect(
      resolveMSTeamsAutoThreadId({
        to: "conversation:19:channel@thread.tacv2",
        toolContext: {
          ...sameChannel,
          replyToMode: "first",
          hasRepliedRef: { value: true },
        },
      }),
    ).toBeUndefined();
  });

  it("returns undefined when currentThreadTs is missing", () => {
    expect(
      resolveMSTeamsAutoThreadId({
        to: "conversation:19:channel@thread.tacv2",
        toolContext: {
          currentChannelId: "conversation:19:channel@thread.tacv2",
          replyToMode: "all",
        },
      }),
    ).toBeUndefined();
  });
});
