import { describe, expect, it } from "vitest";

import {
  looksLikeBlueBubblesTargetId,
  normalizeBlueBubblesMessagingTarget,
} from "./targets.js";

describe("normalizeBlueBubblesMessagingTarget", () => {
  it("normalizes chat_guid targets", () => {
    expect(normalizeBlueBubblesMessagingTarget("chat_guid:ABC-123")).toBe("chat_guid:ABC-123");
  });

  it("normalizes group numeric targets to chat_id", () => {
    expect(normalizeBlueBubblesMessagingTarget("group:123")).toBe("chat_id:123");
  });

  it("strips provider prefix and normalizes handles", () => {
    expect(
      normalizeBlueBubblesMessagingTarget("bluebubbles:imessage:User@Example.com"),
    ).toBe("imessage:user@example.com");
  });
});

describe("looksLikeBlueBubblesTargetId", () => {
  it("accepts chat targets", () => {
    expect(looksLikeBlueBubblesTargetId("chat_guid:ABC-123")).toBe(true);
  });

  it("accepts email handles", () => {
    expect(looksLikeBlueBubblesTargetId("user@example.com")).toBe(true);
  });

  it("accepts phone numbers with punctuation", () => {
    expect(looksLikeBlueBubblesTargetId("+1 (555) 123-4567")).toBe(true);
  });

  it("rejects display names", () => {
    expect(looksLikeBlueBubblesTargetId("Jane Doe")).toBe(false);
  });
});
