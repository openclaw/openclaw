/**
 * Stat output parsers for sandbox filesystem bridges.
 *
 * Handles GNU/BSD size and mtime formats returned through backend shell commands.
 */
import { parseStrictNonNegativeInteger } from "../../infra/parse-finite-number.js";
import { asDateTimestampMs } from "../../shared/number-coercion.js";

/** Parses GNU stat's raw hex mode into the portable sandbox stat type. */
export function parseSandboxStatModeType(
  value: string | undefined,
): "file" | "directory" | "other" {
  const raw = value ?? "";
  if (!/^[0-9a-f]+$/i.test(raw)) {
    return "other";
  }
  const mode = Number.parseInt(raw, 16);
  const fileType = mode & 0xf000;
  if (fileType === 0x4000) {
    return "directory";
  }
  if (fileType === 0x8000) {
    return "file";
  }
  return "other";
}

/** Parses file sizes, capping huge integer strings at the largest safe JS integer. */
export function parseSandboxStatSize(value: string | undefined): number {
  const raw = value ?? "0";
  const parsed = parseStrictNonNegativeInteger(raw);
  if (parsed !== undefined) {
    return parsed;
  }
  return /^\d+$/.test(raw) ? Number.MAX_SAFE_INTEGER : 0;
}

/** Parses GNU stat's epoch seconds into the bridge's millisecond timestamp contract. */
export function parseSandboxStatMtimeMs(value: string | undefined): number {
  const raw = value ?? "0";
  if (!/^\d+(?:\.\d+)?$/.test(raw)) {
    return 0;
  }
  const mtimeMs = Number(raw) * 1000;
  return asDateTimestampMs(mtimeMs) ?? 0;
}
