export type CompiledGlobPattern =
  | { kind: "all" }
  | { kind: "exact"; value: string }
  | { kind: "regex"; value: RegExp };

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const GLOB_REGEX_CACHE = new Map<string, RegExp>();

export function compileGlobPattern(params: {
  raw: string;
  normalize: (value: string) => string;
}): CompiledGlobPattern {
  const normalized = params.normalize(params.raw);
  if (!normalized) {
    return { kind: "exact", value: "" };
  }
  if (normalized === "*") {
    return { kind: "all" };
  }
  if (!normalized.includes("*")) {
    return { kind: "exact", value: normalized };
  }
  let regex = GLOB_REGEX_CACHE.get(normalized);
  if (!regex) {
    regex = new RegExp(`^${escapeRegex(normalized).replaceAll("\\*", ".*")}$`);
    GLOB_REGEX_CACHE.set(normalized, regex);
  }
  return { kind: "regex", value: regex };
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
  for (const pattern of patterns) {
    if (pattern.kind === "all") {
      return true;
    }
    if (pattern.kind === "exact" && value === pattern.value) {
      return true;
    }
    if (pattern.kind === "regex" && pattern.value.test(value)) {
      return true;
    }
  }
  return false;
}
