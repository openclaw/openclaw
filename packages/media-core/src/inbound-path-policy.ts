import path from "node:path";

const WILDCARD_SEGMENT = "*";
const WINDOWS_DRIVE_ABS_RE = /^[A-Za-z]:\//;
const WINDOWS_DRIVE_ROOT_RE = /^[A-Za-z]:$/;

function normalizePosixAbsolutePath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0")) {
    return undefined;
  }
  // Compare all roots as POSIX-style absolute paths so channel configs can use
  // stable patterns even when a source reports Windows separators.
  const normalized = path.posix.normalize(trimmed.replaceAll("\\", "/"));
  const isAbsolute = normalized.startsWith("/") || WINDOWS_DRIVE_ABS_RE.test(normalized);
  if (!isAbsolute || normalized === "/") {
    return undefined;
  }
  const withoutTrailingSlash = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  if (WINDOWS_DRIVE_ROOT_RE.test(withoutTrailingSlash)) {
    return undefined;
  }
  return WINDOWS_DRIVE_ABS_RE.test(withoutTrailingSlash)
    ? withoutTrailingSlash.toLowerCase()
    : withoutTrailingSlash;
}

function splitPathSegments(value: string): string[] {
  return value.split("/").filter(Boolean);
}

export type InboundPathRootMatch = {
  anchorRoot: string;
  matchedRoot: string;
};

function joinAbsolutePathSegments(candidatePath: string, segments: readonly string[]): string {
  const joined = segments.join("/");
  if (!WINDOWS_DRIVE_ABS_RE.test(candidatePath)) {
    return `/${joined}`;
  }
  return segments.length === 1 ? `${joined}/` : joined;
}

function resolveRootPatternMatch(params: {
  candidatePath: string;
  rootPattern: string;
}): InboundPathRootMatch | undefined {
  const candidateSegments = splitPathSegments(params.candidatePath);
  const rootSegments = splitPathSegments(params.rootPattern);
  if (
    candidateSegments.length < rootSegments.length ||
    rootSegments.some(
      (expected, index) => expected !== WILDCARD_SEGMENT && expected !== candidateSegments[index],
    )
  ) {
    return undefined;
  }
  const resolvedSegments = candidateSegments.slice(0, rootSegments.length);
  const firstWildcardIndex = rootSegments.indexOf(WILDCARD_SEGMENT);
  const anchorSegments =
    firstWildcardIndex === -1 ? resolvedSegments : rootSegments.slice(0, firstWildcardIndex);
  return {
    anchorRoot: joinAbsolutePathSegments(params.candidatePath, anchorSegments),
    matchedRoot: joinAbsolutePathSegments(params.candidatePath, resolvedSegments),
  };
}

function normalizeInboundPathRootPattern(value: string): string | undefined {
  const normalized = normalizePosixAbsolutePath(value);
  if (!normalized) {
    return undefined;
  }
  const segments = splitPathSegments(normalized);
  return segments.length > 0 &&
    segments.every((segment) => segment === WILDCARD_SEGMENT || !segment.includes("*"))
    ? normalized
    : undefined;
}

/** Validates an absolute inbound root pattern with whole-segment wildcards only. */
export function isValidInboundPathRootPattern(value: string): boolean {
  return normalizeInboundPathRootPattern(value) !== undefined;
}

/** Normalizes configured inbound attachment roots, dropping invalid or duplicate patterns. */
export function normalizeInboundPathRoots(roots?: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const root of roots ?? []) {
    if (typeof root !== "string") {
      continue;
    }
    const candidate = normalizeInboundPathRootPattern(root);
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    normalized.push(candidate);
  }
  return normalized;
}

/** Merges inbound attachment root lists while preserving first-seen priority. */
export function mergeInboundPathRoots(
  ...rootsLists: Array<readonly string[] | undefined>
): string[] {
  return normalizeInboundPathRoots(rootsLists.flatMap((roots) => roots ?? []));
}

/** Resolves the concrete lexical root matched by an inbound path pattern. */
export function resolveInboundPathRoot(params: {
  filePath: string;
  roots: readonly string[];
  fallbackRoots?: readonly string[];
}): InboundPathRootMatch | undefined {
  const candidatePath = normalizePosixAbsolutePath(params.filePath);
  if (!candidatePath) {
    return undefined;
  }
  const roots = normalizeInboundPathRoots(params.roots);
  const effectiveRoots =
    roots.length > 0 ? roots : normalizeInboundPathRoots(params.fallbackRoots ?? undefined);
  if (effectiveRoots.length === 0) {
    return undefined;
  }
  for (const rootPattern of effectiveRoots) {
    const resolved = resolveRootPatternMatch({ candidatePath, rootPattern });
    if (resolved) {
      return resolved;
    }
  }
  return undefined;
}

/** Checks whether a candidate inbound media path is covered by configured or fallback roots. */
export function isInboundPathAllowed(params: {
  filePath: string;
  roots: readonly string[];
  fallbackRoots?: readonly string[];
}): boolean {
  return resolveInboundPathRoot(params) !== undefined;
}
