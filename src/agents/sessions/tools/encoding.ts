/**
 * File encoding auto-detection for the session read tool.
 *
 * On win32, delegates to the shared Windows codepage decoder so legacy text
 * files (GBK, Big5, etc.) are decoded with the active console codepage.
 * On other platforms, preserves the original UTF-8-only behavior.
 */
import { Buffer } from "node:buffer";
import { decodeWindowsOutputBuffer } from "../../../infra/windows-encoding.js";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);

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

function stripBom(buffer: Buffer, encoding: string | null): Buffer {
  if (encoding === "utf-8") {
    return buffer.subarray(UTF8_BOM.length);
  }
  if (encoding === "utf-16le" || encoding === "utf-16be") {
    return buffer.subarray(UTF16LE_BOM.length);
  }
  return buffer;
}

function decodeStrictUtf8(buffer: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

/**
 * Decodes a file buffer.  On win32, falls back to the active console codepage
 * (GBK, Big5, Shift_JIS, etc.) via the shared `decodeWindowsOutputBuffer`.
 * On other platforms, preserves the original UTF-8-only behavior so that
 * legacy encodings are not silently mis-decoded.
 */
export function decodeFileBuffer(buffer: Buffer): string {
  if (buffer.length === 0) {
    return "";
  }

  // 1. BOM-prefixed encodings
  const bomEncoding = detectBomEncoding(buffer);
  if (bomEncoding !== null) {
    const body = stripBom(buffer, bomEncoding);
    return new TextDecoder(bomEncoding).decode(body);
  }

  // 2. Strict UTF-8 — valid for the vast majority of files
  const strictUtf8 = decodeStrictUtf8(buffer);
  if (strictUtf8 !== null) {
    return strictUtf8;
  }

  // 3. On win32, delegate to the shared Windows codepage decoder which
  //    uses the active console codepage (resolved once via chcp).
  if (process.platform === "win32") {
    return decodeWindowsOutputBuffer({ buffer });
  }

  // 4. Final fallback: lenient UTF-8 (original behavior, no guessing).
  return buffer.toString("utf-8");
}
