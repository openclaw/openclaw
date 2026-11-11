import { describe, expect, it } from "vitest";
import { readTelegramWidgetQuery } from "./widget-bot-api.js";
import { createTelegramWidgetRequestGate } from "./widget-query-router.js";

describe("Telegram widget request gate", () => {
  it("admits a request text once per window per widget", () => {
    let now = 0;
    const admit = createTelegramWidgetRequestGate(() => now);
    expect(admit("1:10", "refresh")).toBe(true);
    // A widget polling with the same data in the background reaches the agent once.
    now = 5_000;
    expect(admit("1:10", "refresh")).toBe(false);
    expect(admit("1:10", "vote:2")).toBe(true);
    expect(admit("1:11", "refresh")).toBe(true);
    now = 61_000;
    expect(admit("1:10", "refresh")).toBe(true);
  });

  it("caps distinct requests at ten per minute per widget", () => {
    const admit = createTelegramWidgetRequestGate(() => 0);
    const results = Array.from({ length: 12 }, (_, i) => admit("1:10", `tap:${i}`));
    expect(results.filter(Boolean)).toHaveLength(10);
  });
});

describe("readTelegramWidgetQuery", () => {
  const query = {
    id: "q1",
    from: { id: 7, is_bot: false, first_name: "A" },
    chat: { id: 7, type: "private", first_name: "A" },
    message_id: 42,
    chat_instance: "1",
    type: { type: "data" },
    data: "inc",
  };

  it("reads an original-message widget query", () => {
    expect(readTelegramWidgetQuery({ update_id: 1, widget_query: query })).toMatchObject({
      id: "q1",
      message_id: 42,
      data: "inc",
    });
  });

  it("ignores inline-message queries without a chat route", () => {
    const { chat: _chat, message_id: _messageId, ...inline } = query;
    expect(
      readTelegramWidgetQuery({ widget_query: { ...inline, inline_message_id: "abc" } }),
    ).toBeUndefined();
  });
});

describe("formatTelegramWidgetRequestText", () => {
  it("names the widget and its current state so the agent keeps the state shape", async () => {
    const { formatTelegramWidgetRequestText } = await import("./widget-query-router.js");
    const text = formatTelegramWidgetRequestText("vote:v", { title: "Poll", state: '{"v":0}' });
    expect(text).toMatch(/^widget_request: vote:v\n/);
    expect(text).toContain('the widget "Poll"');
    expect(text).toContain(JSON.stringify('{"v":0}'));
  });

  it("includes short widget code so a later session can keep the state shape", async () => {
    const { formatTelegramWidgetRequestText } = await import("./widget-query-router.js");
    const source = "<script>draw(JSON.parse(TelegramWidget.chatData).done)</script>";
    expect(formatTelegramWidgetRequestText("done:1", { title: "Today", source })).toContain(
      `Widget code:\n${source}`,
    );
    expect(
      formatTelegramWidgetRequestText("done:1", { title: "Today", source: "x".repeat(9_000) }),
    ).not.toContain("Widget code:");
  });
});
