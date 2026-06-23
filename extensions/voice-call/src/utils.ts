// Voice Call helper module supports utils behavior.
import os from "node:os";
import path from "node:path";

// Small path helpers shared by voice-call setup and runtime flows.

/** Resolve user input paths, including "~" against the current OS home. */
export function resolveUserPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    const expanded = trimmed.replace(/^~(?=$|[\\/])/, os.homedir());
    return path.resolve(expanded);
  }
  return path.resolve(trimmed);
}

/**
 * Read a trimmed, non-empty string argument from a tool-call args object (the realtime model passes
 * tool args as an arbitrary object). Returns undefined if absent, not a string, or blank.
 */
export function readArgText(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
