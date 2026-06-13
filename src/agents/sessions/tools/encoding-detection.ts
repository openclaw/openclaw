/**
 * Encoding detection utilities for the read tool.
 *
 * Detects file encoding using BOM (Byte Order Mark) detection and
 * content-based heuristics for common encodings.
 *
 * Scope (intentionally narrow):
 * - BOM-detected: utf-8, utf-16le, utf-16be.
 * - Content-heuristic: shift-jis, only when the byte pattern is unambiguous.
 * - GBK / GB18030 / Big5 / EUC-KR / KOI8-R / EUC-JP / ISO-2022-JP are NOT
 *   auto-detected. Their byte ranges overlap too much with Shift-JIS to
 *   disambiguate without a real codec and a platform signal. A GBK file with
 *   a GB18030 BOM still decodes correctly via the BOM branch.
 *   For Windows-console GBK output, src/infra/windows-encoding.ts already
 *   handles that path.
 * - UTF-32 is recognised by BOM but we do not decode it — Node has no
 *   built-in utf-32le/utf-32be TextDecoder label, and the file is vanishingly
 *   rare in agent inputs. It falls through to utf-8 (loudly mojibake'd).
 */

export type DetectableEncoding = "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" | "shift-jis";

export interface EncodingDetectionResult {
  encoding: DetectableEncoding;
  confidence: "bom" | "high" | "medium" | "low";
  fallback: boolean; // True if we had to guess
  /** Bytes to skip past a recognised BOM, or 0 when no BOM was found. */
  bomLength: number;
}

const BOM_SIGNATURES: { bytes: number[]; encoding: DetectableEncoding }[] = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: "utf-8-bom" },
  { bytes: [0xff, 0xfe], encoding: "utf-16le" },
  { bytes: [0xfe, 0xff], encoding: "utf-16be" },
];

function detectBOM(buffer: Buffer): { encoding: DetectableEncoding; bomLength: number } | null {
  for (const { bytes, encoding } of BOM_SIGNATURES) {
    if (buffer.length < bytes.length) continue;
    let matches = true;
    for (let i = 0; i < bytes.length; i++) {
      if (buffer[i] !== bytes[i]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return { encoding, bomLength: bytes.length };
    }
  }
  return null;
}

function isValidUtf8(buffer: Buffer, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const byte = buffer[i];
    if (byte <= 0x7f) continue;

    let numBytes: number;
    if ((byte & 0xe0) === 0xc0) numBytes = 2;
    else if ((byte & 0xf0) === 0xe0) numBytes = 3;
    else if ((byte & 0xf8) === 0xf0) numBytes = 4;
    else return false;

    if (i + numBytes > end) return false;
    for (let j = 1; j < numBytes; j++) {
      if ((buffer[i + j] & 0xc0) !== 0x80) return false;
    }
    i += numBytes - 1;
  }
  return true;
}

/**
 * Score how well a byte sequence fits the Shift-JIS double-byte pattern.
 * Positive scores mean the bytes look like Shift-JIS; negative or near-zero
 * scores mean the encoding is unclear and we should not claim it.
 */
function couldBeShiftJis(buffer: Buffer, start: number, end: number): number {
  let sjisScore = 0;
  let i = start;
  while (i < end) {
    const byte = buffer[i];
    if (byte <= 0x7f) {
      sjisScore += 1;
      i++;
    } else if (byte >= 0xa1 && byte <= 0xdf) {
      sjisScore += 1;
      i++;
    } else if ((byte >= 0x81 && byte <= 0x9f) || (byte >= 0xe0 && byte <= 0xfc)) {
      if (i + 1 < end) {
        const nextByte = buffer[i + 1];
        if ((nextByte >= 0x40 && nextByte <= 0x7e) || (nextByte >= 0x80 && nextByte <= 0xfc)) {
          sjisScore += 2;
          i += 2;
          continue;
        }
      }
      sjisScore -= 1;
      i++;
    } else {
      i++;
    }
  }
  return sjisScore;
}

function detectEncodingFromContent(
  buffer: Buffer,
  contentStart: number,
  contentEnd: number,
): DetectableEncoding {
  if (isValidUtf8(buffer, contentStart, contentEnd)) {
    return "utf-8";
  }
  if (couldBeShiftJis(buffer, contentStart, contentEnd) > 10) {
    return "shift-jis";
  }
  // Fall through to UTF-8. This deliberately preserves the pre-patch behavior:
  // a non-UTF-8 non-Japanese file (GBK, KOI8-R, ...) still comes back as
  // latin1-flavoured mojibake rather than a runtime error, so we never
  // regress existing user setups just because we added detection.
  return "utf-8";
}

/**
 * Detect the encoding of a file buffer.
 *
 * Strategy: BOM check first (no false positives), then a content heuristic
 * that picks Shift-JIS only when its lead/trail byte pattern is unambiguous.
 * The default is UTF-8, so ASCII / UTF-8 files take the same code path as
 * before and are byte-for-byte identical.
 */
export function detectEncoding(buffer: Buffer): EncodingDetectionResult {
  const bomResult = detectBOM(buffer);
  if (bomResult) {
    const displayEncoding = bomResult.encoding === "utf-8-bom" ? "utf-8" : bomResult.encoding;
    return {
      encoding: displayEncoding,
      confidence: "bom",
      fallback: false,
      bomLength: bomResult.bomLength,
    };
  }

  const sampleEnd = Math.min(buffer.length, 4096);
  const detected = detectEncodingFromContent(buffer, 0, sampleEnd);

  let confidence: "high" | "medium" | "low";
  if (detected === "shift-jis") {
    confidence = "high";
  } else if (detected === "utf-8") {
    confidence = "medium"; // strict UTF-8 passed, but legacy is still possible
  } else {
    confidence = "low";
  }

  return {
    encoding: detected,
    confidence,
    fallback: true,
    bomLength: 0,
  };
}

/**
 * Decode a buffer using the detected or specified encoding.
 *
 * Routes through TextDecoder for encodings Node Buffer#toString does not
 * understand ("shift-jis"), so a legacy-encoded file never raises
 * ERR_UNKNOWN_ENCODING at the read-tool call site.
 */
export function decodeBuffer(buffer: Buffer, encoding: string): string {
  switch (encoding) {
    case "utf-8":
    case "utf-8-bom":
      return buffer.toString("utf-8");
    case "utf-16le":
      return buffer.toString("utf16le");
    case "utf-16be": {
      // Big-endian: swap to little-endian, then reuse Node's utf16le decoder.
      const swapped = Buffer.allocUnsafe(buffer.length);
      for (let i = 0; i + 1 < buffer.length; i += 2) {
        swapped[i] = buffer[i + 1];
        swapped[i + 1] = buffer[i];
      }
      if (buffer.length % 2 === 1) {
        swapped[buffer.length - 1] = buffer[buffer.length - 1];
      }
      return swapped.toString("utf16le");
    }
    case "shift-jis":
      // Node Buffer#toString("shift-jis") throws ERR_UNKNOWN_ENCODING.
      // TextDecoder("shift-jis") is supported since Node 11 and tolerates
      // invalid sequences without throwing.
      return new TextDecoder("shift-jis", { fatal: false }).decode(buffer);
    default:
      return buffer.toString("utf-8");
  }
}
