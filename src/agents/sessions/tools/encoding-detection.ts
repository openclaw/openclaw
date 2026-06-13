/**
 * Encoding detection utilities for the read tool.
 *
 * Detects file encoding using BOM (Byte Order Mark) detection and
 * content-based heuristics for common encodings.
 */

/**
 * Supported encodings for detection.
 */
export type DetectableEncoding =
  | "utf-8"
  | "utf-8-bom"
  | "utf-16le"
  | "utf-16be"
  | "gbk"
  | "shift-jis"
  | "euc-jp"
  | "iso-8859-1"
  | "windows-1252";

/**
 * Result of encoding detection.
 */
export interface EncodingDetectionResult {
  encoding: DetectableEncoding;
  confidence: "bom" | "high" | "medium" | "low";
  fallback: boolean; // True if we had to guess
}

/**
 * BOM signatures for different encodings.
 */
const BOM_SIGNATURES: { bytes: number[]; encoding: DetectableEncoding }[] = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: "utf-8-bom" },
  { bytes: [0xff, 0xfe], encoding: "utf-16le" },
  { bytes: [0xfe, 0xff], encoding: "utf-16be" },
  { bytes: [0xff, 0xfe, 0x00, 0x00], encoding: "utf-16le" }, // UTF-32 LE
  { bytes: [0x00, 0x00, 0xfe, 0xff], encoding: "utf-16be" }, // UTF-32 BE
];

/**
 * Detect encoding from BOM (Byte Order Mark) at the start of the buffer.
 */
export function detectBOM(buffer: Buffer): { encoding: DetectableEncoding; bomLength: number } | null {
  for (const { bytes, encoding } of BOM_SIGNATURES) {
    if (buffer.length >= bytes.length) {
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
  }
  return null;
}

/**
 * Check if a byte sequence is valid UTF-8.
 */
function isValidUtf8(buffer: Buffer, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const byte = buffer[i];

    // ASCII (0x00-0x7F)
    if (byte <= 0x7f) {
      continue;
    }

    // Determine the number of bytes in this character
    let numBytes: number;
    if ((byte & 0xe0) === 0xc0) {
      numBytes = 2; // 110xxxxx - 2 byte sequence
    } else if ((byte & 0xf0) === 0xe0) {
      numBytes = 3; // 1110xxxx - 3 byte sequence
    } else if ((byte & 0xf8) === 0xf0) {
      numBytes = 4; // 11110xxx - 4 byte sequence
    } else {
      // Invalid UTF-8 start byte
      return false;
    }

    // Check that we have enough bytes remaining
    if (i + numBytes > end) {
      return false;
    }

    // Check continuation bytes (must start with 10)
    for (let j = 1; j < numBytes; j++) {
      if ((buffer[i + j] & 0xc0) !== 0x80) {
        return false;
      }
    }

    i += numBytes - 1;
  }
  return true;
}

/**
 * Check if a byte sequence could be valid GBK/CP936 encoded text.
 * GBK uses 1 or 2 bytes:
 * - First byte: 0x81-0xFE
 * - Second byte: 0x40-0xFE (or 0x80-0xFE in GB18030)
 */
function couldBeGbk(buffer: Buffer, start: number, end: number): number {
  let gbkScore = 0;
  let i = start;

  while (i < end) {
    const byte = buffer[i];

    if (byte <= 0x7f) {
      // ASCII
      gbkScore += 1;
      i++;
    } else if (byte >= 0x81 && byte <= 0xfe) {
      // Potential GBK lead byte
      if (i + 1 < end) {
        const nextByte = buffer[i + 1];
        if (nextByte >= 0x40 && nextByte <= 0xfe && nextByte !== 0x7f) {
          // Valid GBK second byte
          gbkScore += 2;
          i += 2;
          continue;
        }
      }
      // Lead byte without valid following byte - likely not GBK
      gbkScore -= 1;
      i++;
    } else {
      // Byte that doesn't fit ASCII or GBK lead byte
      i++;
    }
  }

  return gbkScore;
}

/**
 * Check if a byte sequence could be valid Shift-JIS encoded text.
 */
function couldBeShiftJis(buffer: Buffer, start: number, end: number): number {
  let sjisScore = 0;
  let i = start;

  while (i < end) {
    const byte = buffer[i];

    if (byte <= 0x7f) {
      // ASCII
      sjisScore += 1;
      i++;
    } else if (byte >= 0xa1 && byte <= 0xdf) {
      // Half-width katakana (single byte in Shift-JIS)
      sjisScore += 1;
      i++;
    } else if (byte >= 0x81 && byte <= 0x9f) {
      // Shift-JIS lead byte (2 bytes)
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
    } else if (byte >= 0xe0 && byte <= 0xfc) {
      // Shift-JIS lead byte (2 bytes)
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

/**
 * Detect the encoding of a buffer using heuristics.
 * This is called when no BOM is present.
 */
function detectEncodingFromContent(buffer: Buffer): DetectableEncoding {
  const contentStart = 0;
  const contentEnd = Math.min(buffer.length, 4096); // Sample first 4KB

  // First, check if it's valid UTF-8
  if (isValidUtf8(buffer, contentStart, contentEnd)) {
    return "utf-8";
  }

  // Check for other legacy encodings
  const gbkScore = couldBeGbk(buffer, contentStart, contentEnd);
  const sjisScore = couldBeShiftJis(buffer, contentStart, contentEnd);

  // GBK typically has higher scores for Chinese text
  if (gbkScore > 10 && gbkScore > sjisScore) {
    return "gbk";
  }

  // Shift-JIS for Japanese
  if (sjisScore > 10) {
    return "shift-jis";
  }

  // Default to UTF-8 for backward compatibility
  // Even if it has some invalid bytes, it might be the intended encoding
  return "utf-8";
}

/**
 * Detect the encoding of a file buffer.
 *
 * Detection strategy:
 * 1. Check for BOM (Byte Order Mark) - highest confidence
 * 2. Analyze content for common encoding patterns
 * 3. Default to UTF-8 for backward compatibility
 *
 * @param buffer - The file buffer to analyze
 * @returns Encoding detection result with confidence level
 */
export function detectEncoding(buffer: Buffer): EncodingDetectionResult {
  // Step 1: Check for BOM
  const bomResult = detectBOM(buffer);
  if (bomResult) {
    // Convert BOM encoding to standard encoding name for display
    const displayEncoding = bomResult.encoding === "utf-8-bom" ? "utf-8" : bomResult.encoding;
    return {
      encoding: displayEncoding as DetectableEncoding,
      confidence: "bom",
      fallback: false,
    };
  }

  // Step 2: Content-based detection
  const detectedEncoding = detectEncodingFromContent(buffer);

  // Step 3: Determine confidence based on encoding
  let confidence: "high" | "medium" | "low";
  switch (detectedEncoding) {
    case "gbk":
    case "shift-jis":
      confidence = "high";
      break;
    case "utf-8":
      confidence = "medium"; // Could be legacy encoding with some invalid bytes
      break;
    default:
      confidence = "low";
  }

  return {
    encoding: detectedEncoding,
    confidence,
    fallback: true,
  };
}

/**
 * Decode a buffer using the detected or specified encoding.
 */
export function decodeBuffer(buffer: Buffer, encoding: string): string {
  switch (encoding) {
    case "utf-8":
    case "utf-8-bom":
      return buffer.toString("utf-8");

    case "utf-16le":
      return buffer.toString("utf16le");

    case "utf-16be": {
      // For big-endian, we need to swap bytes
      const swapped = Buffer.alloc(buffer.length);
      for (let i = 0; i < buffer.length; i += 2) {
        if (i + 1 < buffer.length) {
          swapped[i] = buffer[i + 1];
          swapped[i + 1] = buffer[i];
        }
      }
      return swapped.toString("utf16le");
    }

    case "gbk":
    case "cp936":
      // Node.js doesn't support GBK natively, use iconv-lite or similar
      // For now, try to decode with latin1 and hope for the best
      // In a real implementation, you'd use a library like iconv-lite
      return decodeWithFallback(buffer, "gbk");

    case "shift-jis":
      return decodeWithFallback(buffer, "shift-jis");

    case "iso-8859-1":
    case "latin1":
      return buffer.toString("latin1");

    case "windows-1252":
      return decodeWithFallback(buffer, "windows-1252");

    default:
      return buffer.toString("utf-8");
  }
}

/**
 * Fallback decoder for encodings not natively supported by Node.js.
 * Uses statistical analysis to decode the content.
 */
function decodeWithFallback(buffer: Buffer, targetEncoding: string): string {
  // Try to use a text decoder if available (Node.js 11+)
  try {
    const decoder = new TextDecoder(targetEncoding, { fatal: false });
    return decoder.decode(buffer);
  } catch {
    // Fallback: decode as latin1 (ISO-8859-1)
    // This preserves byte values but may show mojibake
    return buffer.toString("latin1");
  }
}

/**
 * Convert encoding name to Node.js compatible encoding string.
 */
export function toNodeEncoding(encoding: string): string {
  switch (encoding) {
    case "utf-8":
    case "utf-8-bom":
      return "utf-8";
    case "utf-16le":
      return "utf16le";
    case "iso-8859-1":
    case "latin1":
      return "latin1";
    default:
      return encoding;
  }
}
