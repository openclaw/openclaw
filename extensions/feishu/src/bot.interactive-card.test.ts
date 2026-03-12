import { describe, expect, it } from "vitest";
import { parseFeishuMessageEvent } from "./bot.js";

function makeInteractiveEvent(card: unknown, messageType = "interactive") {
  return {
    sender: { sender_id: { user_id: "u1", open_id: "ou_sender" } },
    message: {
      message_id: "msg_1",
      chat_id: "oc_chat1",
      chat_type: "p2p",
      message_type: messageType,
      content: JSON.stringify(card),
      mentions: [],
    },
  };
}

describe("parseFeishuMessageEvent – interactive cards", () => {
  it("extracts readable text from interactive card elements", () => {
    const ctx = parseFeishuMessageEvent(
      makeInteractiveEvent({
        header: { title: { content: "Header" } },
        elements: [
          { tag: "markdown", content: "hello markdown" },
          { tag: "div", text: { content: "hello div" } },
        ],
      }) as any,
    );

    expect(ctx.content).toBe("Header\nhello markdown\nhello div");
    expect(ctx.contentType).toBe("interactive");
  });

  it("supports interactive_card alias", () => {
    const ctx = parseFeishuMessageEvent(
      makeInteractiveEvent(
        {
          header: { title: { content: "Alias Header" } },
          elements: [{ tag: "markdown", content: "alias body" }],
        },
        "interactive_card",
      ) as any,
    );

    expect(ctx.content).toBe("Alias Header\nalias body");
    expect(ctx.contentType).toBe("interactive_card");
  });

  it("extracts schema 2.0 body.elements", () => {
    const ctx = parseFeishuMessageEvent(
      makeInteractiveEvent({
        schema: "2.0",
        body: {
          elements: [{ tag: "markdown", content: "Hello from body" }],
        },
      }) as any,
    );

    expect(ctx.content).toBe("Hello from body");
  });

  it("falls back to raw JSON when no readable text is extracted", () => {
    const raw = JSON.stringify({ schema: "2.0", body: { elements: [{ tag: "button" }] } });
    const event = {
      sender: { sender_id: { user_id: "u1", open_id: "ou_sender" } },
      message: {
        message_id: "msg_1",
        chat_id: "oc_chat1",
        chat_type: "p2p",
        message_type: "interactive",
        content: raw,
        mentions: [],
      },
    };

    const ctx = parseFeishuMessageEvent(event as any);
    expect(ctx.content).toBe(raw);
  });

  it("falls back to placeholder when card is malformed", () => {
    const ctx = parseFeishuMessageEvent(makeInteractiveEvent("not-an-object") as any);
    expect(ctx.content).toBe("[Interactive Card]");
  });
});
