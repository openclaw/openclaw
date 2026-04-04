/**
 * Quick PDF validation for CFE receipts
 * Checks for CFE RFC (CFE370814QI0) before calling expensive API
 */

import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const CFE_RFC = "CFE370814QI0";

export interface ValidationResult {
  isValid: boolean;
  reason?: string;
}

/**
 * Quick check if PDF contains CFE RFC
 * Checks both raw text and decompressed Flate streams (CFE Mi Espacio
 * PDFs use compressed streams where the RFC is not visible in raw bytes).
 */
export function quickValidateCFEPdf(filePath: string): ValidationResult {
  try {
    const buffer = readFileSync(filePath);
    const raw = buffer.toString("latin1");

    // 1. Check raw bytes first (fastest path)
    if (raw.includes(CFE_RFC)) {
      return { isValid: true };
    }

    // 2. Check if it's even a PDF
    if (!raw.startsWith("%PDF")) {
      return { isValid: false, reason: "not_pdf" };
    }

    // 3. Decompress Flate streams and search inside them
    //    CFE Mi Espacio PDFs embed the RFC in compressed content streams
    const streamPattern = /stream\r?\n([\s\S]*?)endstream/g;
    let match: RegExpExecArray | null;
    while ((match = streamPattern.exec(raw)) !== null) {
      try {
        const compressed = Buffer.from(match[1], "latin1");
        const decompressed = inflateSync(compressed).toString("latin1");
        if (decompressed.includes(CFE_RFC)) {
          return { isValid: true };
        }
      } catch {
        // Not a Flate stream or corrupted — skip
      }
    }

    return {
      isValid: false,
      reason: "not_cfe_receipt",
    };
  } catch (error) {
    return {
      isValid: false,
      reason: error instanceof Error ? error.message : "read_error",
    };
  }
}

/**
 * For images, we can't do quick validation
 * Must send to API for OCR
 */
export function quickValidateCFEImage(_filePath: string): ValidationResult {
  // Images require OCR, can't do quick text search
  // Always return valid to let API handle it
  return { isValid: true };
}

/**
 * Main validation dispatcher
 */
export function quickValidateCFE(filePath: string, mimeType: string): ValidationResult {
  if (mimeType === "application/pdf") {
    return quickValidateCFEPdf(filePath);
  }

  // Images: jpeg, png, webp
  if (mimeType.startsWith("image/")) {
    return quickValidateCFEImage(filePath);
  }

  return {
    isValid: false,
    reason: "unsupported_format",
  };
}
