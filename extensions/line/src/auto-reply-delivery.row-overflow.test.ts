// Line tests cover auto reply row-overflow table delivery.
import { chunkMarkdownText } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it } from "vitest";
import { deliverLineAutoReply } from "./auto-reply-delivery.js";
import { baseDeliveryParams, createDeps } from "./auto-reply-delivery.test-helpers.js";
import { processLineMessage as processOrderedLineMessage } from "./markdown-to-line.js";

describe("row-overflow table delivery boundary", () => {
  it("delivers all rows as ordered text when a 15-row 2-column table overflows the receipt cap via reply token", async () => {
    const { replyMessageLine, pushMessagesLine } = createDeps({
      processLineMessage: processOrderedLineMessage,
      chunkMarkdownText,
    });
    const rows = Array.from({ length: 15 }, (_, i) => `| Item${i + 1} | $${i + 1}.00 |`).join("\n");
    const markdown = `Header\n\n| Name | Price |\n|---|---|\n${rows}\n\nFooter`;

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: markdown },
      lineData: {},
    });

    expect(result.status).toBe("delivered");
    expect(result.replyTokenUsed).toBe(true);
    const allMessages = [
      ...replyMessageLine.mock.calls.flatMap(([, msgs]) => msgs),
      ...pushMessagesLine.mock.calls.flatMap(([, msgs]) => msgs),
    ];
    const allText = allMessages
      .filter((m) => m.type === "text")
      .map((m) => m.text)
      .join(" ");
    for (let i = 1; i <= 15; i++) {
      expect(allText).toContain(`Item${i}`);
    }
    expect(allText).toContain("Header");
    expect(allText).toContain("Footer");
    expect(allText.indexOf("Header")).toBeLessThan(allText.indexOf("Item1"));
    expect(allText.indexOf("Item15")).toBeLessThan(allText.indexOf("Footer"));
    expect(allMessages.some((m) => m.type === "flex" && m.altText === "Table")).toBe(false);
  });

  it("delivers all rows when a 2-column table with inline markup overflows the generic cap", async () => {
    const { replyMessageLine, pushMessagesLine } = createDeps({
      processLineMessage: processOrderedLineMessage,
      chunkMarkdownText,
    });
    const markupRows = Array.from({ length: 11 }, (_, i) =>
      i === 0 ? "| `code` **bold** | Val1 |" : `| Item${i + 1} | $${i + 1}.00 |`,
    ).join("\n");
    const markdown = `| Name | Price |\n|---|---|\n${markupRows}`;

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: markdown },
      lineData: {},
    });

    expect(result.status).toBe("delivered");
    const allMessages = [
      ...replyMessageLine.mock.calls.flatMap(([, msgs]) => msgs),
      ...pushMessagesLine.mock.calls.flatMap(([, msgs]) => msgs),
    ];
    expect(allMessages.some((m) => m.type === "flex" && m.altText === "Table")).toBe(false);
    const deliveredLines = allMessages
      .filter((m) => m.type === "text")
      .flatMap((message) => message.text.split(/\r?\n/u).map((line) => line.trim()));
    const expectedLabels = [
      "code bold",
      ...Array.from({ length: 10 }, (_, index) => `Item${index + 2}`),
    ];

    expect(deliveredLines.filter((line) => expectedLabels.includes(line))).toEqual(expectedLabels);
    expect(deliveredLines).toContain("• Price: Val1");
    for (let item = 2; item <= 11; item += 1) {
      expect(deliveredLines).toContain(`• Price: $${item}.00`);
    }
  });
});
