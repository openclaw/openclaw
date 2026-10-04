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
  if (normalized === "fast" || normalized === "priority") {
    return "priority";
  }
  if (normalized === "flex") {
    return "flex";
  }
  return trimmed;
}
