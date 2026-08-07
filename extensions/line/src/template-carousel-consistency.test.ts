// Line tests cover carousel cross-column consistency normalization behavior.
import { describe, expect, it } from "vitest";
import { messageAction, postbackAction } from "./actions.js";
import { createCarouselColumn, createTemplateCarousel } from "./template-messages.js";

describe("carousel column consistency", () => {
  const column = (overrides?: { title?: string; thumbnailImageUrl?: string; actions?: number }) =>
    createCarouselColumn({
      title: overrides?.title,
      text: "Text",
      thumbnailImageUrl: overrides?.thumbnailImageUrl,
      actions: Array.from({ length: overrides?.actions ?? 1 }, (_, i) => messageAction(`A${i}`)),
    });
  const getColumns = (template: ReturnType<typeof createTemplateCarousel>) => {
    if (template.template.type !== "carousel") {
      throw new Error("expected a carousel template");
    }
    return template.template.columns;
  };

  it("returns no columns when a textual column has no actions", () => {
    // The dropped column's text would vanish from the carousel while the
    // textual fallback can still deliver it, so the whole carousel degrades.
    const template = createTemplateCarousel([
      column({ actions: 0 }),
      column({ actions: 1 }),
      column({ actions: 0 }),
    ]);

    expect(getColumns(template)).toHaveLength(0);
  });

  it("returns no columns when filtering blank labels empties a textual column", () => {
    // LINE rejects a carousel action whose label is empty ("must be non-empty
    // text"), which would take the whole message down with it.
    const template = createTemplateCarousel([
      createCarouselColumn({ text: "A", actions: [messageAction("", "x"), messageAction("OK")] }),
      createCarouselColumn({ text: "B", actions: [messageAction("", "x")] }),
    ]);

    expect(getColumns(template)).toHaveLength(0);
  });

  it("drops blank-label actions when every column keeps a labeled action", () => {
    const template = createTemplateCarousel([
      createCarouselColumn({ text: "A", actions: [messageAction("", "x"), messageAction("OK")] }),
      createCarouselColumn({ text: "B", actions: [messageAction("", "x"), messageAction("Go")] }),
    ]);

    expect(getColumns(template).map((col) => col.actions)).toEqual([
      [{ type: "message", label: "OK", text: "OK" }],
      [{ type: "message", label: "Go", text: "Go" }],
    ]);
  });

  it("drops a column with no text or labeled action and keeps the rest", () => {
    // Neither a carousel column nor the textual fallback can render a column
    // with nothing textual and no labeled action, so omitting it loses nothing.
    const template = createTemplateCarousel([
      createCarouselColumn({ text: " ", actions: [messageAction("", "x")] }),
      column({ actions: 1 }),
    ]);

    const columns = getColumns(template);
    expect(columns).toHaveLength(1);
    expect(columns[0]?.actions).toHaveLength(1);
  });

  it("returns no columns when a blank-text column keeps labeled actions", () => {
    // The dropped column's labeled action would vanish from the carousel
    // while the textual fallback can still render it, so the whole carousel
    // degrades instead of delivering without it.
    const template = createTemplateCarousel([
      createCarouselColumn({ text: " ", actions: [messageAction("OK")] }),
      column({ actions: 1 }),
    ]);

    expect(getColumns(template)).toHaveLength(0);
  });

  it("drops thumbnails when title folding would overflow the image-column cap", () => {
    // Folding a 40-character title into a 60-character body yields 102
    // characters; with thumbnails kept the image cap (60) would cut authored
    // text, so the decoration is dropped and the 120 cap applies instead.
    const template = createTemplateCarousel([
      createCarouselColumn({
        title: "T".repeat(40),
        text: "x".repeat(60),
        thumbnailImageUrl: "https://example.com/a.jpg",
        actions: [messageAction("OK")],
      }),
      column({ thumbnailImageUrl: "https://example.com/b.jpg" }),
    ]);

    const columns = getColumns(template);
    expect(columns.map((col) => col.thumbnailImageUrl)).toEqual([undefined, undefined]);
    expect(columns[0]?.text).toBe(`${"T".repeat(40)}: ${"x".repeat(60)}`);
    expect(columns[0]?.text.length).toBe(102);
  });

  it("keeps thumbnails when a folded title still fits the image cap", () => {
    const template = createTemplateCarousel([
      createCarouselColumn({
        title: "Short",
        text: "Body",
        thumbnailImageUrl: "https://example.com/a.jpg",
        actions: [messageAction("OK")],
      }),
      column({ thumbnailImageUrl: "https://example.com/b.jpg" }),
    ]);

    const columns = getColumns(template);
    expect(columns.map((col) => col.thumbnailImageUrl)).toEqual([
      "https://example.com/a.jpg",
      "https://example.com/b.jpg",
    ]);
    expect(columns[0]?.text).toBe("Short: Body");
  });

  it("filters blank action labels before the three-action cap", () => {
    // A blank label is unrenderable; letting it consume a capped slot would
    // silently drop the valid third control.
    const created = createCarouselColumn({
      text: "Text",
      actions: [
        messageAction("", "x"),
        messageAction("One"),
        messageAction("Two"),
        messageAction("Three"),
      ],
    });

    expect(created.actions.map((action) => action.label)).toEqual(["One", "Two", "Three"]);
  });

  it("omits an empty column before the ten-column cap", () => {
    // An empty column carries nothing any rendering could show; letting it
    // consume a capped slot would silently drop the valid tenth column.
    const template = createTemplateCarousel([
      createCarouselColumn({ text: " ", actions: [messageAction("", "x")] }),
      ...Array.from({ length: 10 }, () => column({ actions: 1 })),
    ]);

    expect(getColumns(template)).toHaveLength(10);
  });

  it("keeps an unavailable-action fallback as a labeled action", () => {
    const template = createTemplateCarousel([
      createCarouselColumn({
        text: "Text",
        actions: [postbackAction("Buy", `data=${"x".repeat(400)}`)],
      }),
    ]);

    const columns = getColumns(template);
    expect(columns).toHaveLength(1);
    expect(columns[0]?.actions).toEqual([
      {
        type: "message",
        label: "Unavailable",
        text: "Action unavailable: callback data exceeds LINE's limit.",
      },
    ]);
  });

  it("returns no columns instead of trimming unequal action counts", () => {
    // LINE requires equal counts, but trimming to the smallest column would
    // silently delete authored controls; degrading the whole carousel to the
    // textual fallback is visible to the recipient instead.
    const template = createTemplateCarousel([column({ actions: 3 }), column({ actions: 1 })]);

    expect(getColumns(template)).toHaveLength(0);
  });

  it("folds a title into the text when any column lacks one", () => {
    const template = createTemplateCarousel([column({ title: "Titled" }), column()]);

    const columns = getColumns(template);
    for (const col of columns) {
      expect(col.title).toBeUndefined();
    }
    expect(columns.map((col) => col.text)).toEqual(["Titled: Text", "Text"]);
  });

  it("re-resolves the text limit after folding a title", () => {
    // With the title dropped the column becomes titleless, so the folded text
    // may use the 120-character limit instead of the titled 60.
    const template = createTemplateCarousel([
      createCarouselColumn({
        title: "T".repeat(40),
        text: "x".repeat(60),
        actions: [messageAction("OK")],
      }),
      column(),
    ]);

    const first = getColumns(template)[0];
    expect(first?.text).toBe(`${"T".repeat(40)}: ${"x".repeat(60)}`);
    expect(first?.text.length).toBe(102);
  });

  it("omits every thumbnail when any column lacks one", () => {
    const template = createTemplateCarousel([
      column({ thumbnailImageUrl: "https://example.com/a.jpg" }),
      column(),
    ]);

    for (const col of getColumns(template)) {
      expect(col.thumbnailImageUrl).toBeUndefined();
    }
  });

  it("keeps titles, thumbnails, and actions when all columns are consistent", () => {
    const template = createTemplateCarousel([
      column({ title: "One", thumbnailImageUrl: "https://example.com/a.jpg", actions: 2 }),
      column({ title: "Two", thumbnailImageUrl: "https://example.com/b.jpg", actions: 2 }),
    ]);

    const columns = getColumns(template);
    expect(columns.map((col) => col.title)).toEqual(["One", "Two"]);
    expect(columns.map((col) => col.thumbnailImageUrl)).toEqual([
      "https://example.com/a.jpg",
      "https://example.com/b.jpg",
    ]);
    expect(columns.map((col) => col.actions.length)).toEqual([2, 2]);
  });

  it("treats a blank title and thumbnail as absent", () => {
    const template = createTemplateCarousel([
      createCarouselColumn({
        title: "",
        thumbnailImageUrl: "",
        text: "x".repeat(120),
        actions: [messageAction("OK")],
      }),
    ]);

    const first = getColumns(template)[0];
    expect(first?.title).toBeUndefined();
    expect(first?.thumbnailImageUrl).toBeUndefined();
    expect(first?.text).toBe("x".repeat(120));
  });
});
