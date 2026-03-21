import { getMSTeamsRuntime } from "./runtime.js";

/**
 * Build the OpenClaw User-Agent string for outbound HTTP requests.
 * Format: "OpenClaw/<version>" (e.g. "OpenClaw/2026.2.25").
 */
export function buildUserAgent(): string {
  let version: string;
  try {
    version = getMSTeamsRuntime().version;
  } catch {
    version = "unknown";
  }
  return `OpenClaw/${version}`;
}
