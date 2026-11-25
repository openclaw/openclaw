import { describe, expect, it } from "vitest";
import { findConversationBySelectionKey } from "./ui-conversation-key.js";

describe("QA Lab conversation selection", () => {
  it("resolves the selected account without borrowing a same-id conversation", () => {
    const conversations = [
      { accountId: "account-a", id: "shared", kind: "channel" as const },
      { accountId: "account-b", id: "shared", kind: "channel" as const },
      { accountId: "account-a", id: "shared", kind: "direct" as const },
      { accountId: "account-a", id: "other", kind: "channel" as const },
    ];

    expect(
      findConversationBySelectionKey(conversations, '["account-b","channel","shared"]'),
    ).toEqual({ accountId: "account-b", id: "shared", kind: "channel" });
    expect(findConversationBySelectionKey(conversations, '["account-a","channel","shared"]')).toBe(
      conversations[0],
    );
    expect(findConversationBySelectionKey(conversations, '["account-a","channel","other"]')).toBe(
      conversations[3],
    );
    expect(findConversationBySelectionKey(conversations, '["account-a","direct","shared"]')).toBe(
      conversations[2],
    );
    expect(findConversationBySelectionKey(conversations, null)).toBeUndefined();
  });
});
