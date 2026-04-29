import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasFeishuCommentConversationDelivery,
  recordFeishuCommentConversationDelivery,
  resetFeishuCommentConversationDeliveriesForTest,
} from "./comment-delivery-guard.js";

describe("comment delivery guard", () => {
  beforeEach(() => {
    resetFeishuCommentConversationDeliveriesForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T00:00:00.000Z"));
  });

  afterEach(() => {
    resetFeishuCommentConversationDeliveriesForTest();
    vi.useRealTimers();
  });

  it("trims the soonest-to-expire entries first when the guard exceeds its cap", () => {
    for (let index = 0; index < 100; index += 1) {
      recordFeishuCommentConversationDelivery({
        accountId: "default",
        to: `comment:docx:doc_token_1:early_${index}`,
        threadId: `reply_early_${index}`,
      });
    }

    vi.setSystemTime(new Date("2026-04-23T00:00:20.000Z"));
    recordFeishuCommentConversationDelivery({
      accountId: "default",
      to: "comment:docx:doc_token_1:keep_late",
      threadId: "reply_keep_late",
    });

    vi.setSystemTime(new Date("2026-04-23T00:00:10.000Z"));
    recordFeishuCommentConversationDelivery({
      accountId: "default",
      to: "comment:docx:doc_token_1:drop_soon",
      threadId: "reply_drop_soon",
    });

    vi.setSystemTime(new Date("2026-04-23T00:00:30.000Z"));
    for (let index = 0; index < 899; index += 1) {
      recordFeishuCommentConversationDelivery({
        accountId: "default",
        to: `comment:docx:doc_token_1:filler_${index}`,
        threadId: `reply_filler_${index}`,
      });
    }

    expect(
      hasFeishuCommentConversationDelivery({
        accountId: "default",
        to: "comment:docx:doc_token_1:drop_soon",
        threadId: "reply_drop_soon",
      }),
    ).toBe(false);
    expect(
      hasFeishuCommentConversationDelivery({
        accountId: "default",
        to: "comment:docx:doc_token_1:keep_late",
        threadId: "reply_keep_late",
      }),
    ).toBe(true);
  });
});
