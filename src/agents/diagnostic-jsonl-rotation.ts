export const DEFAULT_CACHE_TRACE_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const DEFAULT_CACHE_TRACE_MAX_ARCHIVES = 3;
export const DEFAULT_ANTHROPIC_PAYLOAD_LOG_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const DEFAULT_ANTHROPIC_PAYLOAD_LOG_MAX_ARCHIVES = 5;
export const MAX_DIAGNOSTIC_JSONL_ARCHIVES = 10;

type RotationInput = {
  configMaxFileBytes?: number;
  configMaxArchives?: number;
  envMaxFileBytes?: string;
  envMaxArchives?: string;
  defaultMaxFileBytes: number;
  defaultMaxArchives: number;
};

export type DiagnosticJsonlRotationConfig = {
  maxFileBytes?: number;
  maxArchives: number;
};

function parseNonNegativeIntegerEnv(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

function normalizeNonNegativeInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

export function resolveDiagnosticJsonlRotation(
  input: RotationInput,
): DiagnosticJsonlRotationConfig {
  const resolvedMaxFileBytes =
    parseNonNegativeIntegerEnv(input.envMaxFileBytes) ??
    normalizeNonNegativeInteger(input.configMaxFileBytes) ??
    input.defaultMaxFileBytes;
  const resolvedMaxArchives =
    parseNonNegativeIntegerEnv(input.envMaxArchives) ??
    normalizeNonNegativeInteger(input.configMaxArchives) ??
    input.defaultMaxArchives;

  return {
    maxFileBytes: resolvedMaxFileBytes > 0 ? resolvedMaxFileBytes : undefined,
    maxArchives: Math.min(resolvedMaxArchives, MAX_DIAGNOSTIC_JSONL_ARCHIVES),
  };
}
