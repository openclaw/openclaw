import { describe, expect, it } from "vitest";
import {
  normalizeFeishuEvent,
  resolveFeishuEventRoute,
  resolveNormalizedFeishuEventCategory,
} from "./event.model.js";

describe("event.model", () => {
  it("normalizes IM message events into the direct message model", () => {
    const normalized = normalizeFeishuEvent({
      accountId: "default",
      eventType: "im.message.receive_v1",
      payload: {
        sender: {
          sender_id: {
            open_id: "ou_user_1",
          },
        },
        message: {
          message_id: "om_dc13264520392913903ef6b56f4b55b0",
          chat_id: "oc_123",
          thread_id: "omt_123",
        },
      },
    });

    expect(normalized.route).toBe("direct");
    expect(normalized.category).toBe("im.message");
    expect(normalized.subtype).toBe("receive");
    expect(normalized.sourceId).toBe("om_dc13264520392913903ef6b56f4b55b0");
    expect(normalized.actor).toEqual({ openId: "ou_user_1" });
    expect(normalized.subject).toEqual({
      kind: "chat",
      tokens: {
        chatId: "oc_123",
        messageId: "om_dc13264520392913903ef6b56f4b55b0",
        threadId: "omt_123",
      },
    });
  });

  it("normalizes bitable events with record-focused identifiers", () => {
    const normalized = normalizeFeishuEvent({
      accountId: "default",
      eventType: "drive.file.bitable_record_changed_v1",
      payload: {
        event_id: "evt_123",
        app_token: "bascn123",
        table_id: "tbl_123",
        record: {
          record_id: "rec_123",
        },
        operator_id: {
          open_id: "ou_operator",
        },
      },
    });

    expect(normalized.route).toBe("publish");
    expect(normalized.category).toBe("bitable.record");
    expect(normalized.subtype).toBe("bitable_record_changed");
    expect(normalized.sourceId).toBe("rec_123");
    expect(normalized.actor).toEqual({ openId: "ou_operator" });
    expect(normalized.subject).toEqual({
      kind: "bitable",
      tokens: {
        appToken: "bascn123",
        tableId: "tbl_123",
        recordId: "rec_123",
      },
    });
  });

  it("classifies routes and categories for current direct-path events", () => {
    expect(resolveFeishuEventRoute("im.message.reaction.created_v1")).toBe("direct");
    expect(resolveFeishuEventRoute("drive.notice.comment_add_v1")).toBe("direct");
    expect(resolveFeishuEventRoute("im.chat.member.bot.added_v1")).toBe("publish");
    expect(resolveNormalizedFeishuEventCategory("card.action.trigger")).toBe("card.action");
  });
});
