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

  it("returns content-preserving text for unequal action counts", () => {
    expect(
      buildTemplateMessageFromPayload({
        type: "carousel",
        columns: [column("A", { actions: ["One", "Two"] }), column("B", { actions: ["Three"] })],
      }),
    ).toEqual({ type: "text", text: "A (One / Two)\nB (Three)" });
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
});
