// Slack tests cover thread ts plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveSlackReplyThreadTs } from "./thread-ts.js";

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
