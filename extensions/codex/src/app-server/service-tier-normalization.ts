import type { CodexServiceTier } from "./protocol.js";

export function normalizeCodexServiceTier(value: unknown): CodexServiceTier | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
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
