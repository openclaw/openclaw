import { describe, expect, it } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

describe("buildTelegramMessageContext forwarded debounce batches", () => {
  it("keeps ordinary text plain while attributing only the forwarded segment", async () => {
    const chat = { id: 999, type: "private" as const, first_name: "Alice" };
    const sender = { id: 42, first_name: "Alice", is_bot: false };
    const context = await buildTelegramMessageContextForTest({
      message: {
        message_id: 2,
        chat,
        from: sender,
        text: "ordinary note\nforwarded note",
        forward_origin: {
          type: "hidden_user",
          sender_user_name: "Wrong inherited origin",
          date: 400,
        },
      },
      options: {
        inboundDebounceMessages: [
          {
            message_id: 1,
            date: 1_700_000_000,
            chat,
            from: sender,
            text: "ordinary note",
          },
          {
            message_id: 2,
            date: 1_700_000_001,
            chat,
            from: sender,
            text: "forwarded note",
            forward_origin: {
              type: "hidden_user",
              sender_user_name: "Original B",
              date: 500,
            },
          },
        ],
      },
    });

    const payload = context?.ctxPayload;
    expect(payload?.Body).toMatch(
      /ordinary note\n\[Forwarded from Original B[^\]]*\]\nforwarded note/,
    );
    expect(payload?.Body).not.toContain("Wrong inherited origin");
    expect(payload?.BodyForAgent).toBe("ordinary note\nforwarded note");
    expect(payload?.ForwardedFrom).toBeUndefined();
  });

  it("redacts a debounced forward origin denied by group context visibility", async () => {
    const chat = { id: -1007, type: "group" as const, title: "Ops" };
    const sender = { id: 1, first_name: "Allowed", is_bot: false };
    const context = await buildTelegramMessageContextForTest({
      message: {
        message_id: 2,
        chat,
        from: sender,
        text: "ordinary note\nprivate forwarded note",
      },
      cfg: {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            contextVisibility: "allowlist",
          },
        },
      },
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false, allowFrom: ["1"] },
        topicConfig: undefined,
      }),
      options: {
        inboundDebounceMessages: [
          {
            message_id: 1,
            date: 1_700_000_000,
            chat,
            from: sender,
            text: "ordinary note",
          },
          {
            message_id: 2,
            date: 1_700_000_001,
            chat,
            from: sender,
            text: "private forwarded note",
            forward_origin: {
              type: "user",
              sender_user: {
                id: 999,
                first_name: "Hidden",
                is_bot: false,
              },
              date: 500,
            },
          },
        ],
      },
    });

    const payload = context?.ctxPayload;
    expect(payload?.Body).toContain("ordinary note\nprivate forwarded note");
    expect(payload?.Body).not.toContain("[Forwarded from");
    expect(payload?.Body).not.toContain("Hidden");
    expect(payload?.ForwardedFrom).toBeUndefined();
  });

  it("attributes forwarded media-only segments", async () => {
    const chat = { id: 999, type: "private" as const, first_name: "Alice" };
    const sender = { id: 42, first_name: "Alice", is_bot: false };
    const photo = [{ file_id: "photo-1", file_unique_id: "unique-1", width: 1, height: 1 }];
    const context = await buildTelegramMessageContextForTest({
      message: {
        message_id: 2,
        chat,
        from: sender,
        text: "",
        photo,
      },
      allMedia: [
        { path: "/tmp/photo-1.jpg", contentType: "image/jpeg" },
        { path: "/tmp/photo-2.jpg", contentType: "image/jpeg" },
      ],
      options: {
        inboundDebounceMessages: [
          {
            message_id: 1,
            date: 1_700_000_000,
            chat,
            from: sender,
            photo,
            forward_origin: {
              type: "hidden_user",
              sender_user_name: "Original A",
              date: 500,
            },
          },
          {
            message_id: 2,
            date: 1_700_000_001,
            chat,
            from: sender,
            photo,
            forward_origin: {
              type: "hidden_user",
              sender_user_name: "Original B",
              date: 501,
            },
          },
        ],
      },
    });

    expect(context?.ctxPayload.Body).toMatch(
      /\[Forwarded from Original A[^\]]*\]\n<media:image>\n\[Forwarded from Original B[^\]]*\]\n<media:image>/,
    );
  });
});
