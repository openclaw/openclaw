/**
 * File encoding auto-detection for the session read tool.
 *
 * Delegates to the shared Windows codepage decoder on Windows and falls back
 * through the same codepage priority list on other platforms so that legacy
 * text files (GBK, Big5, etc.) are readable everywhere.
 */
import { Buffer } from "node:buffer";
import {
  decodeWindowsOutputBuffer,
  WINDOWS_CODEPAGE_ENCODING_MAP,
} from "../../../infra/windows-encoding.js";

// Fallback encoding priority for non-Windows platforms, ordered by prevalence
// of legacy file encodings.  Uses the same encoding labels as the shared
// WINDOWS_CODEPAGE_ENCODING_MAP so there is a single source of truth.
const LEGACY_ENCODING_PRIORITY: readonly string[] = [
  WINDOWS_CODEPAGE_ENCODING_MAP[936],   // gbk
  WINDOWS_CODEPAGE_ENCODING_MAP[950],   // big5
  WINDOWS_CODEPAGE_ENCODING_MAP[932],   // shift_jis
  WINDOWS_CODEPAGE_ENCODING_MAP[949],   // euc-kr
  WINDOWS_CODEPAGE_ENCODING_MAP[54936], // gb18030
  WINDOWS_CODEPAGE_ENCODING_MAP[1252],  // windows-1252
];

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
 * Decodes a file buffer using the same encoding policy as the rest of the
 * codebase: BOM-prefixed → strict UTF-8 → Windows active codepage (on win32)
 * or the shared codepage priority list (other platforms).
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

  // 2. Strict UTF-8 (valid for the vast majority of files)
  const strictUtf8 = decodeStrictUtf8(buffer);
  if (strictUtf8 !== null) {
    return strictUtf8;
  }

  // 3. On win32, delegate to the shared Windows codepage decoder which uses
  //    the active console codepage (GBK, Big5, Shift_JIS, etc.).
  if (process.platform === "win32") {
    return decodeWindowsOutputBuffer({ buffer });
  }

  // 4. Non-Windows: try each codepage from the shared map in priority order.
  for (const encoding of LEGACY_ENCODING_PRIORITY) {
    try {
      return new TextDecoder(encoding).decode(buffer);
    } catch {
      continue;
    }
  }

  // 5. Final fallback: lenient UTF-8 (original behavior).
  return buffer.toString("utf-8");
}
