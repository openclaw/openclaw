export type CompiledGlobPattern =
  | { kind: "all"; raw: string }
  | { kind: "exact"; value: string; raw: string }
  | { kind: "regex"; value: RegExp; raw: string };

function escapeRegex(value: string) {
  // Standard "escape string for regex literal" pattern.
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compileGlobPattern(params: {
  raw: string;
  normalize: (value: string) => string;
}): CompiledGlobPattern {
  const normalized = params.normalize(params.raw);
  if (!normalized) {
    return { kind: "exact", value: "", raw: params.raw };
  }
  if (normalized === "*") {
    return { kind: "all", raw: params.raw };
  }
  if (!normalized.includes("*")) {
    return { kind: "exact", value: normalized, raw: params.raw };
  }
  return {
    kind: "regex",
    value: new RegExp(`^${escapeRegex(normalized).replaceAll("\\*", ".*")}$`),
    raw: params.raw,
  };
}

export function compileGlobPatterns(params: {
  raw?: string[] | undefined;
  normalize: (value: string) => string;
}): CompiledGlobPattern[] {
  if (!Array.isArray(params.raw)) {
    return [];
  }
  return params.raw
    .map((raw) => compileGlobPattern({ raw, normalize: params.normalize }))
    .filter((pattern) => pattern.kind !== "exact" || pattern.value);
}

export function matchesAnyGlobPattern(value: string, patterns: CompiledGlobPattern[]): boolean {
  return findMatchingGlobPattern(value, patterns) !== undefined;
}

export function findMatchingGlobPattern(
  value: string,
  patterns: CompiledGlobPattern[],
): string | undefined {
  for (const pattern of patterns) {
    if (pattern.kind === "all") {
      return pattern.raw;
    }
    if (pattern.kind === "exact" && value === pattern.value) {
      return pattern.raw;
    }
    if (pattern.kind === "regex" && pattern.value.test(value)) {
      return pattern.raw;
    }
  }
  return undefined;
}
