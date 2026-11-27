import {
  TEXT_PAGE_DEFAULT_CHARS,
  TEXT_PAGE_MAX_CHARS,
  RECORD_RESPONSE_MAX_BYTES,
} from "./limits.js";

/** Never split a UTF-16 surrogate pair at a read or edit boundary. */
export function splitsPair(text: string, offset: number): boolean {
  return (
    offset > 0 &&
    offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]!) &&
    /[\uDC00-\uDFFF]/.test(text[offset]!)
  );
}

/** Bound a text field by characters and serialized bytes; offsets are UTF-16. */
export function textWindow(text: string, offset = 0, maxChars = TEXT_PAGE_DEFAULT_CHARS) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(maxChars) ||
    maxChars < 256 ||
    maxChars > TEXT_PAGE_MAX_CHARS
  ) {
    throw new Error("Invalid text window.");
  }
  if (splitsPair(text, offset)) {
    throw new Error("Text offset splits a Unicode character.");
  }
  let end = Math.min(text.length, offset + maxChars);
  // Nine recovery fields still fit beneath the complete feature response budget.
  while (Buffer.byteLength(JSON.stringify(text.slice(offset, end))) > RECORD_RESPONSE_MAX_BYTES) {
    end = offset + Math.floor((end - offset) / 2);
  }
  if (splitsPair(text, end)) {
    end--;
  }
  return {
    text: text.slice(offset, end),
    content: { offset, totalChars: text.length, nextOffset: end < text.length ? end : null },
  };
}
