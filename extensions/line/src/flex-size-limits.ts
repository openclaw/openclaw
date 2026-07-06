// Line plugin module owns LINE Flex Message size limits.
import type { FlexContainer } from "./flex-templates.js";

const BYTES_PER_KB = 1024;

export const LINE_FLEX_BUBBLE_MAX_BYTES = 30 * BYTES_PER_KB;
export const LINE_FLEX_CAROUSEL_MAX_BYTES = 50 * BYTES_PER_KB;
export const LINE_FLEX_CAROUSEL_MAX_BUBBLES = 12;

export type LineFlexContainerSize = {
  size: number;
  maxSize: number;
  unit: "bytes" | "bubbles";
};

export function getLineFlexContainerMaxBytes(contents: FlexContainer): number {
  return contents.type === "carousel" ? LINE_FLEX_CAROUSEL_MAX_BYTES : LINE_FLEX_BUBBLE_MAX_BYTES;
}

export function getUtf8JsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export function getLineFlexContainerSize(contents: FlexContainer): LineFlexContainerSize {
  if (contents.type === "carousel") {
    if (contents.contents.length > LINE_FLEX_CAROUSEL_MAX_BUBBLES) {
      return {
        size: contents.contents.length,
        maxSize: LINE_FLEX_CAROUSEL_MAX_BUBBLES,
        unit: "bubbles",
      };
    }

    for (const bubble of contents.contents) {
      const bubbleBytes = getUtf8JsonByteLength(bubble);
      if (bubbleBytes > LINE_FLEX_BUBBLE_MAX_BYTES) {
        return {
          size: bubbleBytes,
          maxSize: LINE_FLEX_BUBBLE_MAX_BYTES,
          unit: "bytes",
        };
      }
    }
  }

  return {
    size: getUtf8JsonByteLength(contents),
    maxSize: getLineFlexContainerMaxBytes(contents),
    unit: "bytes",
  };
}
