// Slack tests cover action threading plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveSlackAutoThreadId } from "./action-threading.js";

describe("resolveSlackAutoThreadId", () => {
  it("matches either native or routable DM targets", () => {
    const context = {
      currentChannelId: "D123",
      currentMessagingTarget: "user:U123",
      currentThreadTs: "thread-1",
      replyToMode: "all" as const,
    };

    expect(resolveSlackAutoThreadId({ to: "user:U123", toolContext: context })).toBe("thread-1");
    expect(resolveSlackAutoThreadId({ to: "U123", toolContext: context })).toBe("thread-1");
    expect(resolveSlackAutoThreadId({ to: "D123", toolContext: context })).toBe("thread-1");
    expect(resolveSlackAutoThreadId({ to: "user:U999", toolContext: context })).toBeUndefined();
  });
});
