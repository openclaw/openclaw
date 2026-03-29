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
  it("extracts readable text from interactive card elements (schema 1.0)", () => {
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

  it("extracts readable text from card body.elements (schema 2.0)", () => {
    const ctx = parseFeishuMessageEvent(
      makeInteractiveEvent({
        header: { title: { content: "Schema 2.0 Header" } },
        body: {
          elements: [
            { tag: "markdown", content: "schema 2.0 content" },
            { tag: "div", text: { content: "schema 2.0 div" } },
          ],
        },
      }) as any,
    );

    expect(ctx.content).toBe("Schema 2.0 Header\nschema 2.0 content\nschema 2.0 div");
    expect(ctx.contentType).toBe("interactive");
  });

  it("prefers schema 1.0 elements over body.elements when both present", () => {
    const ctx = parseFeishuMessageEvent(
      makeInteractiveEvent({
        header: { title: { content: "Mixed" } },
        elements: [{ tag: "markdown", content: "v1 content" }],
        body: {
          elements: [{ tag: "markdown", content: "v2 content" }],
        },
      }) as any,
    );

    expect(ctx.content).toBe("Mixed\nv1 content");
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

  it("falls back to placeholder when card is malformed", () => {
    const ctx = parseFeishuMessageEvent(makeInteractiveEvent("not-an-object") as any);
    expect(ctx.content).toBe("[Interactive Card]");
  });
});
