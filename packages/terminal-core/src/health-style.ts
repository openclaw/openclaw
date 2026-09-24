import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { theme } from "./theme.js";

// Styles the status word in health output lines.

const HEALTH_STATUS_COLORS = [
  ["failed", "error"],
  ["degraded", "warn"],
  ["ok", "success"],
  ["linked", "success"],
  ["configured", "success"],
  ["not linked", "warn"],
  ["not configured", "muted"],
  ["unknown", "warn"],
] as const;

/** Highlight known health status prefixes in a "label: detail" line. */
export function styleHealthChannelLine(line: string, rich: boolean): string {
  if (!rich) {
    return line;
  }

  const colon = line.indexOf(":");
  if (colon === -1) {
    return line;
  }

  const detail = line.slice(colon + 1).trimStart();
  // Only the longest recognized status prefix needs case normalization.
  const normalized = normalizeLowercaseStringOrEmpty(detail.slice(0, "not configured".length));

  const applyPrefix = (prefix: string, color: (value: string) => string) =>
    `${line.slice(0, colon + 1)} ${color(detail.slice(0, prefix.length))}${detail.slice(prefix.length)}`;

  for (const [prefix, color] of HEALTH_STATUS_COLORS) {
    if (normalized.startsWith(prefix)) {
      return applyPrefix(prefix, theme[color]);
    }
  }

  return line;
}
