// Slack tests cover thread ts plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveSlackReplyThreadTs, resolveSlackThreadTsValue } from "./thread-ts.js";

describe("Slack reply target selection", () => {
  it("uses the planned thread when no explicit reply tag exists", () => {
    expect(resolveSlackReplyThreadTs({ replyToMode: "batched", threadId: "planned-thread" })).toBe(
      "planned-thread",
    );
  });

  it("keeps a current reply target when there is no existing thread", () => {
    expect(resolveSlackReplyThreadTs({ replyToCurrent: true, replyToId: "current-message" })).toBe(
      "current-message",
    );
  });
});

describe("Slack thread_ts resolution", () => {
  it("falls back from invalid replyToId to valid threadId", () => {
    expect(
      resolveSlackThreadTsValue({
        replyToId: "msg-internal-1",
        threadId: "1712345678.123456",
      }),
    ).toBe("1712345678.123456");
  });
});
