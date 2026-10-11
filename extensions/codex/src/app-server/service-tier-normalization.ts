import type { CodexServiceTier } from "./protocol.js";

export function normalizeCodexServiceTier(value: unknown): CodexServiceTier | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.toLowerCase();
  return normalized === "fast" || normalized === "priority"
    ? "priority"
    : normalized === "flex"
      ? "flex"
      : trimmed;
}
