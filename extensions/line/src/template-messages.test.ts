import { describe, expect, it } from "vitest";
import {
  createConfirmTemplate,
  createButtonTemplate,
  createTemplateCarousel,
  createCarouselColumn,
  createImageCarousel,
  createImageCarouselColumn,
  createProductCarousel,
  messageAction,
} from "./template-messages.js";

describe("createConfirmTemplate", () => {
  it("truncates text to 240 characters", () => {
    const longText = "x".repeat(300);
    const template = createConfirmTemplate(longText, messageAction("Yes"), messageAction("No"));

    expect((template.template as { text: string }).text.length).toBe(240);
  });
});

describe("createButtonTemplate", () => {
  it("limits actions to 4", () => {
    const actions = Array.from({ length: 6 }, (_, i) => messageAction(`Button ${i}`));
    const template = createButtonTemplate("Title", "Text", actions);

    expect((template.template as { actions: unknown[] }).actions.length).toBe(4);
  });

  it("truncates title to 40 characters", () => {
    const longTitle = "x".repeat(50);
    const template = createButtonTemplate(longTitle, "Text", [messageAction("OK")]);

    expect((template.template as { title: string }).title.length).toBe(40);
  });

  it("truncates text to 60 chars when no thumbnail is provided", () => {
    const longText = "x".repeat(100);
    const template = createButtonTemplate("Title", longText, [messageAction("OK")]);

    expect((template.template as { text: string }).text.length).toBe(60);
  });

  it("keeps longer text when thumbnail is provided", () => {
    const longText = "x".repeat(100);
    const template = createButtonTemplate("Title", longText, [messageAction("OK")], {
      thumbnailImageUrl: "https://example.com/thumb.jpg",
    });

    expect((template.template as { text: string }).text.length).toBe(100);
  });
});

describe("createCarouselColumn", () => {
  it("limits actions to 3", () => {
    const column = createCarouselColumn({
      text: "Text",
      actions: [
        messageAction("A1"),
        messageAction("A2"),
        messageAction("A3"),
        messageAction("A4"),
        messageAction("A5"),
      ],
    });

    expect(column.actions.length).toBe(3);
  });

  it("truncates text to 120 characters", () => {
    const longText = "x".repeat(150);
    const column = createCarouselColumn({ text: longText, actions: [messageAction("OK")] });

    expect(column.text.length).toBe(120);
  });
});

describe("carousel column limits", () => {
  it.each([
    {
      createTemplate: () =>
        createTemplateCarousel(
          Array.from({ length: 15 }, () =>
            createCarouselColumn({ text: "Text", actions: [messageAction("OK")] }),
          ),
        ),
    },
    {
      createTemplate: () =>
        createImageCarousel(
          Array.from({ length: 15 }, (_, i) =>
            createImageCarouselColumn(`https://example.com/${i}.jpg`, messageAction("View")),
          ),
        ),
    },
  ])("limits columns to 10", ({ createTemplate }) => {
    const template = createTemplate();
    expect((template.template as { columns: unknown[] }).columns.length).toBe(10);
  });
});

describe("createProductCarousel", () => {
  it.each([
    {
      title: "Product",
      description: "Desc",
      actionLabel: "Buy",
      actionUrl: "https://shop.com/buy",
      expectedType: "uri",
    },
    {
      title: "Product",
      description: "Desc",
      actionLabel: "Select",
      actionData: "product_id=123",
      expectedType: "postback",
    },
  ])("uses expected action type for product action", ({ expectedType, ...item }) => {
    const template = createProductCarousel([item]);
    const columns = (template.template as { columns: Array<{ actions: Array<{ type: string }> }> })
      .columns;
    expect(columns[0].actions[0].type).toBe(expectedType);
  });
});
