import crypto from "node:crypto";
import { estimateBase64DecodedBytes } from "../media/base64.js";

export const REDACTED_IMAGE_DATA = "<redacted>";

function toLowerTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function hasImageMime(record: Record<string, unknown>): boolean {
  const candidates = [
    toLowerTrimmed(record.mimeType),
    toLowerTrimmed(record.media_type),
    toLowerTrimmed(record.mime_type),
  ];
  return candidates.some((value) => value.startsWith("image/"));
}

function shouldRedactImageData(record: Record<string, unknown>): record is Record<string, string> {
  if (typeof record.data !== "string") {
    return false;
  }
  const type = toLowerTrimmed(record.type);
  return type === "image" || hasImageMime(record);
}

function digestBase64Payload(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Redacts image/base64 payload data from diagnostic objects before persistence.
 */
export function redactImageDataForDiagnostics(value: unknown): unknown {
  const seen = new WeakSet<object>();

  const visit = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map((entry) => visit(entry));
    }
    if (!input || typeof input !== "object") {
      return input;
    }
    if (seen.has(input)) {
      return "[Circular]";
    }
    seen.add(input);

    const record = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(record)) {
      out[key] = visit(val);
    }

    if (shouldRedactImageData(record)) {
      out.data = REDACTED_IMAGE_DATA;
      out.bytes = estimateBase64DecodedBytes(record.data);
      out.sha256 = digestBase64Payload(record.data);
    }
    return out;
  };

  return visit(value);
}
