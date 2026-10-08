import { describe, expect, it } from "vitest";
import { deleteCreatedForumTopicTelegram } from "./send-forum-topics.js";
import { useTelegramHttpFixture } from "./send.telegram-http.test-support.js";

describe("Telegram fork topic cleanup over HTTP", () => {
  const fixture = useTelegramHttpFixture();
  it("deletes only the returned topic ID with a single compensating API call", async () => {
    fixture.responseFor = (method) => (method === "deleteForumTopic" ? true : undefined);
    await deleteCreatedForumTopicTelegram("-100123", 77, {
      cfg: fixture.cfg,
      api: fixture.bot.api,
    });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toMatchObject({
      method: "deleteForumTopic",
      fields: { chat_id: "-100123", message_thread_id: 77 },
    });
  });
});
