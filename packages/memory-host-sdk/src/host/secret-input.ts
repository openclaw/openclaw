import {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
} from "./openclaw-runtime-config.js";

// Memory-specific facade for consuming gateway-resolved provider secret input.

/** Return true when a configured memory secret contains a literal value or reference. */
export function hasConfiguredMemorySecretInput(value: unknown): boolean {
  return hasConfiguredSecretInput(value);
}

/** Consume a secret value that the gateway runtime snapshot already resolved. */
export function resolveMemorySecretInputString(params: {
  value: unknown;
  path: string;
}): string | undefined {
  const resolved = normalizeResolvedSecretInputString(params);
  if (params.value !== undefined && typeof params.value !== "string") {
    throw new Error(`${params.path}: expected a resolved string value.`);
  }
  return resolved;
}
