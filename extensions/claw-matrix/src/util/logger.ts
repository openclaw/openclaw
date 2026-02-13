import type { PluginLogger } from "../openclaw-types.js";

/**
 * Structured logger wrapper.
 *
 * Adds a consistent component tag and optional structured fields to log output.
 * Wraps the injected PluginLogger from OpenClaw — all output goes through the
 * host's logging pipeline. This is intentionally thin: no dependencies, no
 * formatting overhead beyond string concatenation.
 *
 * Usage:
 *   const log = createLogger("sync", hostLogger);
 *   log.info("Sync started", { batch: token });
 *   // => "[sync] Sync started {batch: abc123}"
 */
export interface StructuredLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

function formatFields(fields?: Record<string, unknown>): string {
  if (!fields) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    parts.push(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  return parts.length > 0 ? ` {${parts.join(", ")}}` : "";
}

/**
 * Create a structured logger for a named component.
 *
 * @param component - Tag prefix (e.g., "sync", "crypto", "send")
 * @param base - The PluginLogger from OpenClaw (or undefined for silent)
 */
export function createLogger(component: string, base?: PluginLogger | null): StructuredLogger {
  const tag = `[${component}]`;
  return {
    info(msg: string, fields?: Record<string, unknown>): void {
      base?.info?.(`${tag} ${msg}${formatFields(fields)}`);
    },
    warn(msg: string, fields?: Record<string, unknown>): void {
      (base?.warn ?? base?.info)?.(`${tag} ${msg}${formatFields(fields)}`);
    },
    error(msg: string, fields?: Record<string, unknown>): void {
      base?.error?.(`${tag} ${msg}${formatFields(fields)}`);
    },
  };
}
