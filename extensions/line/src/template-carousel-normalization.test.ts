// Line tests cover provider-valid carousel normalization and fallback behavior.
import { describe, expect, it } from "vitest";
import { buildTemplateMessageFromPayload } from "./template-messages.js";
import type { LineTemplateMessagePayload } from "./types.js";

type CarouselPayload = Extract<LineTemplateMessagePayload, { type: "carousel" }>;

const action = (label: string) => ({ type: "message" as const, label, data: label });
const column = (
  text: string,
  options?: {
    title?: string;
    thumbnailImageUrl?: string;
    actions?: string[];
  },
): CarouselPayload["columns"][number] => ({
  text,
  title: options?.title,
  thumbnailImageUrl: options?.thumbnailImageUrl,
  actions: (options?.actions ?? ["Open"]).map(action),
});

const invalidCases: Array<{
  name: string;
  columns: CarouselPayload["columns"];
  fallback: string;
}> = [
  {
    name: "mixed titles",
    columns: [column("A", { title: "First" }), column("B")],
    fallback: "First: A (Open)\nB (Open)",
  },
  {
    name: "unequal action counts",
    columns: [column("A", { actions: ["One", "Two"] }), column("B", { actions: ["Three"] })],
    fallback: "A (One / Two)\nB (Three)",
  },
  {
    name: "an empty action list",
    columns: [column("A", { actions: [] }), column("B")],
    fallback: "A\nB (Open)",
  },
  {
    name: "a blank label that empties one column",
    columns: [column("A", { actions: [""] }), column("B")],
    fallback: "A\nB (Open)",
  },
];

describe("LINE carousel normalization", () => {
  it("treats empty titles as absent and preserves the titleless text budget", () => {
    const message = buildTemplateMessageFromPayload({
      type: "carousel",
      columns: [column("A".repeat(100), { title: "" }), column("B", { title: "" })],
    });

    expect(message).toMatchObject({
      type: "template",
      template: {
        type: "carousel",
        columns: [
          { title: undefined, text: "A".repeat(100) },
          { title: undefined, text: "B" },
        ],
      },
    });
  });

  it("uses text fallback when an empty title is beside a real title", () => {
    expect(
      buildTemplateMessageFromPayload({
        type: "carousel",
        columns: [column("A", { title: "" }), column("B", { title: "Second" })],
      }),
    ).toEqual({ type: "text", text: "A (Open)\nSecond: B (Open)" });
  });

  it("preserves a provider-valid carousel at the payload boundary", () => {
    const columns = [
      column("A", {
        title: "First",
        thumbnailImageUrl: "https://example.com/a.jpg",
        actions: ["One", "Two"],
      }),
      column("B", {
        title: "Second",
        thumbnailImageUrl: "https://example.com/b.jpg",
        actions: ["Three", "Four"],
      }),
    ];
    expect(
      buildTemplateMessageFromPayload({ type: "carousel", columns, altText: "Options" }),
    ).toEqual({
      type: "template",
      altText: "Options",
      template: {
        type: "carousel",
        columns: [
          {
            title: "First",
            text: "A",
            thumbnailImageUrl: "https://example.com/a.jpg",
            actions: [
              { type: "message", label: "One", text: "One" },
              { type: "message", label: "Two", text: "Two" },
            ],
          },
          {
            title: "Second",
            text: "B",
            thumbnailImageUrl: "https://example.com/b.jpg",
            actions: [
              { type: "message", label: "Three", text: "Three" },
              { type: "message", label: "Four", text: "Four" },
            ],
          },
        ],
        imageAspectRatio: "rectangle",
        imageSize: "cover",
      },
    });
  });

  it.each(invalidCases)("returns content-preserving text for $name", ({ columns, fallback }) => {
    expect(
      buildTemplateMessageFromPayload({
        type: "carousel",
        columns,
      }),
    ).toEqual({ type: "text", text: fallback });
  });

  it("preserves fallback alt text within the provider limit", () => {
    const altText = "a".repeat(1600);
    expect(
      buildTemplateMessageFromPayload({
        type: "carousel",
        columns: [column("A", { actions: [] })],
        altText,
      }),
    ).toEqual({ type: "text", text: `${"a".repeat(1500)}\nA` });
  });

  // Columns that disagree only on their image are left as a carousel: outbound
  // normalization strips every column's image when one of them is unusable, which
  // is what LINE's all-or-none rule needs. Degrading to text here would drop a
  // card that still ships, and `card-image-url.test.ts` pins the stripped wire shape.
  it("keeps a carousel whose columns disagree only on a thumbnail", () => {
    expect(
      buildTemplateMessageFromPayload({
        type: "carousel",
        columns: [column("A", { thumbnailImageUrl: "https://example.com/a.jpg" }), column("B")],
      }),
    ).toMatchObject({ type: "template", template: { type: "carousel" } });
  });

  it("filters blank labels before applying the three-action provider cap", () => {
    const message = buildTemplateMessageFromPayload({
      type: "carousel",
      columns: [
        column("A", { actions: ["", "One", "Two", "Three"] }),
        column("B", { actions: ["", "Four", "Five", "Six"] }),
      ],
    });

    expect(message).toMatchObject({
      type: "template",
      template: {
        type: "carousel",
        columns: [
          { actions: [{ label: "One" }, { label: "Two" }, { label: "Three" }] },
          { actions: [{ label: "Four" }, { label: "Five" }, { label: "Six" }] },
        ],
      },
    });
  });

  it("applies the ten-column provider cap after normalization", () => {
    const message = buildTemplateMessageFromPayload({
      type: "carousel",
      columns: Array.from({ length: 11 }, (_, index) => column(`Column ${index + 1}`)),
    });

    expect(message).toMatchObject({
      type: "template",
      template: { type: "carousel" },
    });
    if (message?.type !== "template" || message.template.type !== "carousel") {
      throw new Error("expected carousel");
    }
    expect(message.template.columns).toHaveLength(10);
  });
});
