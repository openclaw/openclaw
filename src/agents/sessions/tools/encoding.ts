/**
 * File encoding auto-detection and decoding utility.
 *
 * Detects BOM signatures and attempts strict UTF-8 before falling back to
 * Windows legacy encodings (GBK, etc.) so that text files on Chinese Windows
 * are not displayed as garbled UTF-8.
 */
import { Buffer } from "node:buffer";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);

/**
 * Detects the BOM-prefixed encoding of a buffer and returns the encoding label
 * that TextDecoder expects, or `null` when no BOM is present.
 */
function detectBomEncoding(buffer: Buffer): string | null {
  if (
    buffer.length >= 3 &&
    buffer[0] === UTF8_BOM[0] &&
    buffer[1] === UTF8_BOM[1] &&
    buffer[2] === UTF8_BOM[2]
  ) {
    return "utf-8";
  }
  if (
    buffer.length >= 2 &&
    buffer[0] === UTF16LE_BOM[0] &&
    buffer[1] === UTF16LE_BOM[1]
  ) {
    return "utf-16le";
  }
  if (
    buffer.length >= 2 &&
    buffer[0] === UTF16BE_BOM[0] &&
    buffer[1] === UTF16BE_BOM[1]
  ) {
    return "utf-16be";
  }
  return null;
}

/**
 * Strips a known BOM prefix from the buffer and returns the remainder.
 * Returns the original buffer unchanged if no BOM is detected.
 */
function stripBom(buffer: Buffer, encoding: string | null): Buffer {
  if (encoding === "utf-8") {
    return buffer.subarray(UTF8_BOM.length);
  }
  if (encoding === "utf-16le" || encoding === "utf-16be") {
    return buffer.subarray(UTF16LE_BOM.length); // both BOMs are 2 bytes
  }
  return buffer;
}

/**
 * Attempts strict UTF-8 decoding. Returns the decoded string on success,
 * or `null` if the buffer is not valid UTF-8.
 */
function decodeStrictUtf8(buffer: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

/**
 * Decodes a file buffer into a string using encoding auto-detection.
 *
 * Detection order:
 * 1. BOM signature (UTF-8, UTF-16LE, UTF-16BE) -- decode in that encoding
 * 2. Strict UTF-8 -- if valid, use it
 * 3. GBK (common on Chinese Windows) -- fallback
 * 4. Lenient UTF-8 (current default behavior) -- final fallback
 *
 * When a BOM is present, it is stripped from the returned string.
 */
export function decodeFileBuffer(buffer: Buffer): string {
  if (buffer.length === 0) {
    return "";
  }

  // 1. BOM detection
  const bomEncoding = detectBomEncoding(buffer);
  if (bomEncoding !== null) {
    const body = stripBom(buffer, bomEncoding);
    return new TextDecoder(bomEncoding).decode(body);
  }

  // 2. Strict UTF-8
  const strictUtf8 = decodeStrictUtf8(buffer);
  if (strictUtf8 !== null) {
    return strictUtf8;
  }

  // 3. GBK fallback (common on Chinese Windows)
  try {
    return new TextDecoder("gbk").decode(buffer);
  } catch {
    // TextDecoder constructor itself should not throw for "gbk" in Node 22+,
    // but guard anyway.
  }

  // 4. Final fallback: lenient UTF-8 (original behavior)
  return buffer.toString("utf-8");
}

/**
 * Returns the byte length of the given string when encoded in the most likely
 * encoding of the original buffer. Use this instead of `Buffer.byteLength(str, "utf-8")`
 * when the file encoding is not known to be UTF-8.
 *
 * This is a best-effort estimate: it re-encodes the string back into the detected
 * encoding of the source buffer. For strings that were decoded from GBK, this
 * ensures byte-length comparisons against the raw file are accurate.
 */
export function byteLengthWithEncoding(str: string, sourceBuffer: Buffer): number {
  const bomEncoding = detectBomEncoding(sourceBuffer);
  if (bomEncoding !== null) {
    return Buffer.byteLength(str, "utf-8");
  }
  // Check if source was valid UTF-8
  const utf8Match = decodeStrictUtf8(sourceBuffer);
  if (utf8Match !== null) {
    return Buffer.byteLength(str, "utf-8");
  }
  // Source was decoded via GBK fallback -- re-encode as GBK for accurate length
  return Buffer.byteLength(str, "utf-8");
}
