// Line plugin module owns LINE Flex Message size limits.
import type { FlexContainer } from "./flex-templates.js";

const BYTES_PER_KB = 1024;

export const LINE_FLEX_BUBBLE_MAX_BYTES = 30 * BYTES_PER_KB;
export const LINE_FLEX_CAROUSEL_MAX_BYTES = 50 * BYTES_PER_KB;

export type LineFlexContainerSize = {
  byteSize: number;
  maxBytes: number;
};

export function getLineFlexContainerMaxBytes(contents: FlexContainer): number {
  return contents.type === "carousel" ? LINE_FLEX_CAROUSEL_MAX_BYTES : LINE_FLEX_BUBBLE_MAX_BYTES;
}

export function getUtf8JsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export function getLineFlexContainerSize(contents: FlexContainer): LineFlexContainerSize {
  return {
    byteSize: getUtf8JsonByteLength(contents),
    maxBytes: getLineFlexContainerMaxBytes(contents),
  };
}
