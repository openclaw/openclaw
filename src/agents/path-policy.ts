import path from "node:path";
import { normalizeWindowsPathForComparison } from "../infra/path-guards.js";
import { resolveSandboxInputPath } from "./sandbox-paths.js";

type RelativePathOptions = {
  allowRoot?: boolean;
  cwd?: string;
  boundaryLabel?: string;
  includeRootInError?: boolean;
};

export type BoundaryPathMatch = {
  root: string;
  resolved: string;
  relative: string;
};

function throwPathEscapesBoundary(params: {
  options?: RelativePathOptions;
  rootResolved: string;
  candidate: string;
}): never {
  const boundary = params.options?.boundaryLabel ?? "workspace root";
  const suffix = params.options?.includeRootInError ? ` (${params.rootResolved})` : "";
  throw new Error(`Path escapes ${boundary}${suffix}: ${params.candidate}`);
}

function validateRelativePathWithinBoundary(params: {
  relativePath: string;
  isAbsolutePath: (path: string) => boolean;
  options?: RelativePathOptions;
  rootResolved: string;
  candidate: string;
}): string {
  if (params.relativePath === "" || params.relativePath === ".") {
    if (params.options?.allowRoot) {
      return "";
    }
    throwPathEscapesBoundary({
      options: params.options,
      rootResolved: params.rootResolved,
      candidate: params.candidate,
    });
  }
  if (params.relativePath.startsWith("..") || params.isAbsolutePath(params.relativePath)) {
    throwPathEscapesBoundary({
      options: params.options,
      rootResolved: params.rootResolved,
      candidate: params.candidate,
    });
  }
  return params.relativePath;
}

function isRelativePathWithinBoundary(params: {
  relativePath: string;
  isAbsolutePath: (path: string) => boolean;
  allowRoot?: boolean;
}): boolean {
  if (params.relativePath === "" || params.relativePath === ".") {
    return params.allowRoot === true;
  }
  return !(params.relativePath.startsWith("..") || params.isAbsolutePath(params.relativePath));
}

function toRelativePathUnderRoot(params: {
  root: string;
  candidate: string;
  options?: RelativePathOptions;
}): string {
  if (process.platform === "win32") {
    const resolvedInput = path.win32.isAbsolute(params.candidate)
      ? path.win32.resolve(params.candidate)
      : path.win32.resolve(params.options?.cwd ?? params.root, params.candidate);
    const rootResolved = path.win32.resolve(params.root);
    const resolvedCandidate = resolvedInput;
    const rootForCompare = normalizeWindowsPathForComparison(rootResolved);
    const targetForCompare = normalizeWindowsPathForComparison(resolvedCandidate);
    if (targetForCompare === rootForCompare) {
      if (params.options?.allowRoot) {
        return "";
      }
      throwPathEscapesBoundary({
        options: params.options,
        rootResolved,
        candidate: params.candidate,
      });
    }
    if (!targetForCompare.startsWith(`${rootForCompare}\\`)) {
      throwPathEscapesBoundary({
        options: params.options,
        rootResolved,
        candidate: params.candidate,
      });
    }
    const relative = path.win32.relative(rootResolved, resolvedCandidate);
    return relative === "." ? "" : relative;
  }

  const resolvedInput = resolveSandboxInputPath(
    params.candidate,
    params.options?.cwd ?? params.root,
  );

  const rootResolved = path.resolve(params.root);
  const resolvedCandidate = path.resolve(resolvedInput);
  const relative = path.relative(rootResolved, resolvedCandidate);
  return validateRelativePathWithinBoundary({
    relativePath: relative,
    isAbsolutePath: path.isAbsolute,
    options: params.options,
    rootResolved,
    candidate: params.candidate,
  });
}

function toRelativeBoundaryPath(params: {
  root: string;
  candidate: string;
  options?: Pick<RelativePathOptions, "allowRoot" | "cwd">;
  boundaryLabel: string;
  includeRootInError?: boolean;
}): string {
  return toRelativePathUnderRoot({
    root: params.root,
    candidate: params.candidate,
    options: {
      allowRoot: params.options?.allowRoot,
      cwd: params.options?.cwd,
      boundaryLabel: params.boundaryLabel,
      includeRootInError: params.includeRootInError,
    },
  });
}

export function toRelativeWorkspacePath(
  root: string,
  candidate: string,
  options?: Pick<RelativePathOptions, "allowRoot" | "cwd">,
): string {
  return toRelativeBoundaryPath({
    root,
    candidate,
    options,
    boundaryLabel: "workspace root",
  });
}

export function toRelativeSandboxPath(
  root: string,
  candidate: string,
  options?: Pick<RelativePathOptions, "allowRoot" | "cwd">,
): string {
  return toRelativeBoundaryPath({
    root,
    candidate,
    options,
    boundaryLabel: "sandbox root",
    includeRootInError: true,
  });
}

export function resolvePathFromInput(filePath: string, cwd: string): string {
  return path.normalize(resolveSandboxInputPath(filePath, cwd));
}

export function normalizeBoundaryRoots(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const candidate of roots) {
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }
    const resolved =
      process.platform === "win32" ? path.win32.resolve(trimmed) : path.resolve(trimmed);
    const key =
      process.platform === "win32" ? normalizeWindowsPathForComparison(resolved) : resolved;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(resolved);
  }
  return normalized;
}

export function resolvePathWithinRoots(
  roots: readonly string[],
  candidate: string,
  options?: RelativePathOptions,
): BoundaryPathMatch {
  const normalizedRoots = normalizeBoundaryRoots(roots);
  if (normalizedRoots.length === 0) {
    throw new Error("No boundary roots configured.");
  }

  const escapeOptions: RelativePathOptions = {
    ...options,
    boundaryLabel:
      options?.boundaryLabel ?? (normalizedRoots.length > 1 ? "allowed work roots" : undefined),
  };
  if (process.platform === "win32") {
    const resolvedInput = resolveSandboxInputPath(candidate, options?.cwd ?? normalizedRoots[0]);
    const resolvedCandidate = path.win32.resolve(resolvedInput);
    let bestMatch: BoundaryPathMatch | null = null;
    for (const root of normalizedRoots) {
      const compareRoot = normalizeWindowsPathForComparison(root);
      const compareCandidate = normalizeWindowsPathForComparison(resolvedCandidate);
      if (compareCandidate === compareRoot) {
        if (options?.allowRoot !== true) {
          continue;
        }
      } else if (!compareCandidate.startsWith(`${compareRoot}\\`)) {
        continue;
      }
      const relative = path.win32.relative(root, resolvedCandidate);
      const match = {
        root,
        resolved: resolvedCandidate,
        relative: relative === "." ? "" : relative,
      } satisfies BoundaryPathMatch;
      if (!bestMatch || match.root.length > bestMatch.root.length) {
        bestMatch = match;
      }
    }
    if (bestMatch) {
      return bestMatch;
    }
    return throwPathEscapesBoundary({
      options: escapeOptions,
      rootResolved: normalizedRoots[0],
      candidate,
    });
  }

  const resolvedInput = resolveSandboxInputPath(candidate, options?.cwd ?? normalizedRoots[0]);
  const resolvedCandidate = path.resolve(resolvedInput);
  let bestMatch: BoundaryPathMatch | null = null;
  for (const root of normalizedRoots) {
    const relative = path.relative(root, resolvedCandidate);
    if (
      !isRelativePathWithinBoundary({
        relativePath: relative,
        isAbsolutePath: path.isAbsolute,
        allowRoot: options?.allowRoot,
      })
    ) {
      continue;
    }
    const match = {
      root,
      resolved: resolvedCandidate,
      relative: relative === "." ? "" : relative,
    } satisfies BoundaryPathMatch;
    if (!bestMatch || match.root.length > bestMatch.root.length) {
      bestMatch = match;
    }
  }
  if (bestMatch) {
    return bestMatch;
  }
  return throwPathEscapesBoundary({
    options: escapeOptions,
    rootResolved: normalizedRoots[0],
    candidate,
  });
}
