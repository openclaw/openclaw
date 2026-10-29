import { describe, expect, it, vi } from "vitest";
import type { RichText } from "./rich-block-model.js";
import { buildTelegramRichMarkdownPlan } from "./rich-message.js";
import { planTelegramTextDeliveryPages } from "./telegram-text-delivery.js";

describe("rich-message span work", () => {
  it.each([
    { name: "Markdown", open: "**", close: "**" },
    { name: "HTML", open: "<b>", close: "</b>" },
  ])("expires short spans inside a continuing $name wrapper", ({ open, close }) => {
    const count = 512;
    const words = Array.from({ length: count }, (_, index) => `word${index}`);
    const markdown = `${open}${words.map((word) => `_${word}_`).join(" ")} tail${close}`;
    const plainText = `${words.join(" ")} tail`;
    const text: RichText[] = words.flatMap((word, index) => [
      { type: "italic" as const, text: word },
      index === count - 1 ? " tail" : " ",
    ]);
    const richMessage = {
      blocks: [{ type: "paragraph" as const, text: { type: "bold" as const, text } }],
      skip_entity_detection: true,
    };
    let endReads = 0;
    let observedSpans = 0;
    const sort = Array.prototype.sort;
    // Observe the real compositor's range reads without replacing its parser,
    // span ordering, or output. Sorting itself is outside the sweep budget.
    const observer = vi.spyOn(Array.prototype, "sort").mockImplementation(function (
      this: unknown[],
      compare,
    ) {
      const result = sort.call(this, compare);
      if (
        this.length !== count + 1 ||
        !this.every(
          (span): span is { kind: "style" | "html"; start: number; end: number } =>
            typeof span === "object" &&
            span !== null &&
            "kind" in span &&
            (span.kind === "style" || span.kind === "html") &&
            "start" in span &&
            typeof span.start === "number" &&
            "end" in span &&
            typeof span.end === "number",
        )
      ) {
        return result;
      }
      for (const span of this) {
        const end = span.end;
        observedSpans += 1;
        Object.defineProperty(span, "end", {
          configurable: true,
          enumerable: true,
          get: () => {
            endReads += 1;
            return end;
          },
        });
      }
      return result;
    });
    try {
      expect(buildTelegramRichMarkdownPlan(markdown, { skipEntityDetection: true })).toEqual({
        richMessage,
        plainText,
        degradationReasons: [],
      });
      expect(
        planTelegramTextDeliveryPages({
          text: markdown,
          maxChars: 32_768,
          richMessages: true,
          skipEntityDetection: true,
        }),
      ).toEqual([
        {
          richMessage,
          plainText,
          sourceText: plainText,
          sourceTextMode: "markdown",
          degradationReasons: [],
        },
      ]);
      expect(observedSpans).toBe(2 * (count + 1));
      expect(endReads).toBeLessThanOrEqual(32 * (count + 1));
    } finally {
      observer.mockRestore();
    }
  });
});
