import type * as Lark from "@larksuiteoapi/node-sdk";
import { MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH } from "./docx-table-ops.js";

/**
 * Read image pixel width from a PNG or JPEG buffer without external
 * dependencies. Returns null for unsupported or malformed inputs.
 *
 * PNG: width is a big-endian uint32 at byte offset 16 (inside the IHDR chunk).
 * JPEG: scan for the first SOF0–SOF3 marker (0xFF 0xC0–0xC3) and read the
 *       width field at marker_offset + 7 (big-endian uint16).
 *
 * Known limitation: WebP and GIF are not parsed. Images in those formats will
 * still be inserted correctly, but the table column width will not be adjusted
 * to match the image's pixel dimensions.
 */
// ── PNG header offsets ────────────────────────────────────────────────────────
// Byte layout: [0–7] signature | [8–11] IHDR length | [12–15] "IHDR" | [16–19] width
const PNG_SIG_0 = 0x89; // first byte of PNG signature
const PNG_SIG_1 = 0x50; // 'P'
const PNG_SIG_2 = 0x4e; // 'N'
const PNG_SIG_3 = 0x47; // 'G'
const PNG_MIN_HEADER_BYTES = 24; // need at least 24 bytes to read IHDR width
const PNG_WIDTH_OFFSET = 16; // big-endian uint32 at byte 16

// ── JPEG header offsets ───────────────────────────────────────────────────────
// SOI marker: 0xFF 0xD8.  Each subsequent segment: [0xFF][marker][length(2)][data...]
// SOF0–SOF3 layout: 0xFF marker(1) length(2) precision(1) height(2) width(2)
const JPEG_MARKER_PREFIX = 0xff;
const JPEG_SOI_BYTE = 0xd8; // second byte of SOI marker
const JPEG_MIN_SOI_BYTES = 4; // need ≥4 bytes to detect SOI + first segment marker
const JPEG_SCAN_START = 2; // skip the 2-byte SOI marker
const JPEG_SEGMENT_LOOKAHEAD = 8; // need i+8 bytes readable to safely decode SOF width
const JPEG_SOF_FIRST = 0xc0; // SOF0 — baseline DCT
const JPEG_SOF_LAST = 0xc3; // SOF3 — lossless sequential
// SOF field layout: marker[2] + length[2] + precision[1] + height[2] → width at +7
const JPEG_SOF_WIDTH_OFFSET = 7;
const JPEG_MARKER_BYTES = 2; // 0xFF + marker_id
const JPEG_SEG_LENGTH_OFFSET = 2; // length field starts 2 bytes into the segment

export function getImageWidth(buf: Buffer): number | null {
  // PNG: identify by 4-byte signature, read width from IHDR chunk at offset 16
  if (
    buf.length >= PNG_MIN_HEADER_BYTES &&
    buf[0] === PNG_SIG_0 &&
    buf[1] === PNG_SIG_1 &&
    buf[2] === PNG_SIG_2 &&
    buf[3] === PNG_SIG_3
  ) {
    return buf.readUInt32BE(PNG_WIDTH_OFFSET);
  }
  // JPEG: starts with 0xFF 0xD8; scan segments for SOF0–SOF3
  if (
    buf.length >= JPEG_MIN_SOI_BYTES &&
    buf[0] === JPEG_MARKER_PREFIX &&
    buf[1] === JPEG_SOI_BYTE
  ) {
    let i = JPEG_SCAN_START;
    while (i + JPEG_SEGMENT_LOOKAHEAD < buf.length) {
      if (buf[i] !== JPEG_MARKER_PREFIX) break;
      const marker = buf[i + 1];
      if (marker >= JPEG_SOF_FIRST && marker <= JPEG_SOF_LAST) {
        // SOF layout: 0xFF marker(1) marker_id(1) length(2) precision(1) height(2) width(2)
        return buf.readUInt16BE(i + JPEG_SOF_WIDTH_OFFSET);
      }
      // Advance past this segment: marker bytes + length field value
      const segLen = buf.readUInt16BE(i + JPEG_SEG_LENGTH_OFFSET);
      i += JPEG_MARKER_BYTES + segLen;
    }
  }
  return null;
}
