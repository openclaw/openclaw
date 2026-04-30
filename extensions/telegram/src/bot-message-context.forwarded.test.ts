import { describe, expect, it } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

describe("buildTelegramMessageContext forwarded metadata", () => {
  it("keeps typed forwarded origin when the sender forwarded their own message", async () => {
    const context = await buildTelegramMessageContextForTest({
      message: {
        message_id: 42,
        chat: { id: 999, type: "private" },
        from: {
          id: 999,
          first_name: "Bob",
          last_name: "Smith",
          username: "bobsmith",
          is_bot: false,
        },
        text: "This is from an earlier chat",
        date: 1736380800,
        forward_origin: {
          type: "user",
          sender_user: {
            id: 999,
            first_name: "Bob",
            last_name: "Smith",
            username: "bobsmith",
            is_bot: false,
          },
          date: 500,
        },
      },
    });

    expect(context).not.toBeNull();
    const payload = context?.ctxPayload;
    expect(payload?.SenderId).toBe("999");
    expect(payload?.ForwardedFromId).toBe("999");
    expect(payload?.BodyForAgent).toBe("This is from an earlier chat");
    expect(payload?.RawBody).toBe("This is from an earlier chat");
  });
});
