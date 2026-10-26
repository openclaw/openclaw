import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

/**
 * `plugins.entries.crabbox.config.sandbox`: how the sandbox backend leases a
 * box. The manifest `configSchema` validates the JSON shape; this resolver
 * normalizes it and coexists with the sibling `warmImages` block.
 */
export type ResolvedCrabboxSandboxConfig = Partial<Record<(typeof FIELDS)[number], string>>;

const FIELDS = ["provider", "class", "binary", "ttl", "idleTimeout"] as const;

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
  const resolved: ResolvedCrabboxSandboxConfig = {};
  for (const key of FIELDS) {
    const value = raw[key];
    if (value === undefined) {
      continue;
    }
    const trimmed = normalizeOptionalString(value);
    if (!trimmed) {
      throw new Error(`Crabbox sandbox.${key} must be a non-empty string.`);
    }
    resolved[key] = trimmed;
  }
  return resolved;
}
