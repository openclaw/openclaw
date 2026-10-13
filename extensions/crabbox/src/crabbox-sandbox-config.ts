import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

/**
 * `plugins.entries.crabbox.config.sandbox`: how the sandbox backend leases a
 * box. The manifest `configSchema` validates the JSON shape; this resolver
 * normalizes it and coexists with the sibling `warmImages` block.
 */
export type ResolvedCrabboxSandboxConfig = Partial<Record<(typeof FIELDS)[number], string>>;

const DURATION_PATTERN = /^\d+(?:ms|s|m|h)$/u;
const FIELDS = ["provider", "class", "binary", "ttl", "idleTimeout"] as const;
const KNOWN_FIELDS: ReadonlySet<string> = new Set(FIELDS);

/** Returns undefined when no sandbox block is configured; the backend then stays unregistered. */
export function resolveCrabboxSandboxConfig(
  pluginConfig?: Record<string, unknown>,
): ResolvedCrabboxSandboxConfig | undefined {
  const raw = pluginConfig?.sandbox;
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    throw new Error("Crabbox sandbox must be an object.");
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(key)) {
      throw new Error(`Crabbox sandbox.${key} is not a supported option.`);
    }
  }
  const resolved: ResolvedCrabboxSandboxConfig = {};
  for (const key of FIELDS) {
    const value = raw[key];
    if (value === undefined) {
      continue;
    }
    const trimmed = normalizeOptionalString(value);
    const duration = key === "ttl" || key === "idleTimeout";
    if (!trimmed || (duration && !DURATION_PATTERN.test(trimmed))) {
      throw new Error(
        `Crabbox sandbox.${key} must be ${duration ? "a duration such as 90m, 2h, or 30s" : "a non-empty string"}.`,
      );
    }
    resolved[key] = trimmed;
  }
  return resolved;
}
