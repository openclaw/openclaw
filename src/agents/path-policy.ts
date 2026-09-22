/**
 * Shared workspace and sandbox path boundary helpers.
 *
 * Converts validated absolute or relative inputs into root-relative paths without allowing boundary escapes.
 */
import path from "node:path";
import { pathExistsSync } from "../infra/fs-safe.js";
import { normalizeWindowsPathPreservingCase } from "../infra/path-guards.js";
import { resolveSandboxInputPath } from "./sandbox-paths.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.types.js";

/** Compare resolved runtime paths using the declared root's syntax, never the host OS. */
export function relativePathInsideSandboxRoot(root: string, target: string): string | null {
  const windows = !root.startsWith("/") && path.win32.isAbsolute(root);
  const syntax = windows ? path.win32 : path.posix;
  const normalize = windows ? normalizeWindowsPathPreservingCase : path.posix.normalize;
  const normalizedRoot = normalize(root);
  const normalizedTarget = normalize(target);
  if (
    !syntax.isAbsolute(normalizedRoot) ||
    !syntax.isAbsolute(normalizedTarget) ||
    (windows &&
      (path.win32.parse(normalizedRoot).root === "\\" ||
        path.win32.parse(normalizedTarget).root === "\\"))
  ) {
    return null;
  }
  const relative = syntax.relative(normalizedRoot, normalizedTarget);
  return relative === ".." || relative.startsWith(`..${syntax.sep}`) || syntax.isAbsolute(relative)
    ? null
    : relative;
}

/** Select the deepest admitted mapping without replacing a supplied miss with a host fallback. */
export function resolveSandboxPathMapping<
  T extends { readonly hostRoot: string; readonly containerRoot: string },
>(mappings: readonly T[], target: string): { mapping: T; hostPath: string } | null {
  let selected: { mapping: T; hostPath: string; relative: string } | undefined;
  for (const mapping of mappings) {
    const relative = relativePathInsideSandboxRoot(mapping.containerRoot, target);
    // A shorter relative suffix means a deeper root after normalization. Equal
    // roots retain the backend's ordering, including protected mount precedence.
    if (relative === null || (selected && relative.length >= selected.relative.length)) {
      continue;
    }
    const separator = mapping.containerRoot.startsWith("/") ? "/" : "\\";
    selected = {
      mapping,
      relative,
      hostPath: path.resolve(mapping.hostRoot, ...relative.split(separator)),
    };
  }
  return selected ? { mapping: selected.mapping, hostPath: selected.hostPath } : null;
}

// Shared path boundary helpers for workspace and sandbox-facing agent inputs.
// Callers get normalized relative paths only after the candidate proves it stays
// within the named root.
type RelativePathOptions = {
  allowRoot?: boolean;
  cwd?: string;
  boundaryLabel?: string;
  includeRootInError?: boolean;
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
  // path.relative returns "." for the root itself. Treat that as escaping unless
  // the caller explicitly accepts root-targeting operations.
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
  // The absolute-path check catches Windows drive-relative oddities after
  // normalization, while the prefix checks cover ordinary parent traversal.
  if (
    params.relativePath === ".." ||
    params.relativePath.startsWith("../") ||
    params.relativePath.startsWith("..\\") ||
    params.isAbsolutePath(params.relativePath)
  ) {
    throwPathEscapesBoundary({
      options: params.options,
      rootResolved: params.rootResolved,
      candidate: params.candidate,
    });
  }
  return params.relativePath;
}

function toRelativePathUnderRoot(params: {
  root: string;
  candidate: string;
  options?: RelativePathOptions;
}): string {
  const resolvedInput = resolveSandboxInputPath(
    params.candidate,
    params.options?.cwd ?? params.root,
  );

  if (process.platform === "win32") {
    // path.win32.relative already matches the root case-insensitively, so normalization
    // here only strips extended-length prefixes that would otherwise read as an escape.
    // It must not lowercase: this relative path is what callers create files from, and
    // Windows is case-insensitive but case-preserving.
    const rootResolved = path.win32.resolve(params.root);
    const resolvedCandidate = path.win32.resolve(resolvedInput);
    const rootForCompare = normalizeWindowsPathPreservingCase(rootResolved);
    const targetForCompare = normalizeWindowsPathPreservingCase(resolvedCandidate);
    const relative = path.win32.relative(rootForCompare, targetForCompare);
    return validateRelativePathWithinBoundary({
      relativePath: relative,
      isAbsolutePath: path.win32.isAbsolute,
      options: params.options,
      rootResolved,
      candidate: params.candidate,
    });
  }

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

/**
 * Return a workspace-relative path for a candidate path after rejecting paths
 * that escape the workspace root.
 */
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

/**
 * Return a sandbox-relative path for a candidate path after rejecting paths that
 * escape the sandbox root. Errors include the sandbox root for operator clarity.
 */
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

/** Resolve a user-supplied path against `cwd` using the sandbox input rules. */
export function resolvePathFromInput(filePath: string, cwd: string): string {
  return path.normalize(resolveSandboxInputPath(filePath, cwd));
}

/** Disambiguate an existing literal relative filename from `@` file-reference shorthand. */
export function preserveAtPrefixedRelativePath(filePath: string, cwd: string): string;
export function preserveAtPrefixedRelativePath(
  filePath: string,
  cwd: string,
  bridge: SandboxFsBridge | undefined,
  signal?: AbortSignal,
): string | Promise<string>;
export function preserveAtPrefixedRelativePath(
  filePath: string,
  cwd: string,
  bridge?: SandboxFsBridge,
  signal?: AbortSignal,
): string | Promise<string> {
  if (!filePath.startsWith("@")) {
    return filePath;
  }
  const stripped = filePath.slice(1);
  if (
    !stripped ||
    stripped === "~" ||
    stripped.startsWith("~/") ||
    stripped.startsWith("~\\") ||
    /^file:\/\//i.test(stripped) ||
    path.posix.isAbsolute(stripped) ||
    path.win32.isAbsolute(stripped)
  ) {
    // Absolute/home/URL mentions must reach existing workspace guards unchanged.
    return filePath;
  }
  // `./` preserves literal @ through legacy resolvers without breaking TUI mentions.
  const literalPath = `./${filePath}`;
  let literalAncestor = filePath;
  while (true) {
    const parent = path.dirname(literalAncestor);
    if (parent === "." || parent === literalAncestor) {
      break;
    }
    literalAncestor = parent;
  }
  const ancestorPath = literalAncestor === filePath ? undefined : `./${literalAncestor}`;
  const mountedHostPath = bridge?.resolvePath({ filePath: literalPath, cwd }).hostPath;
  if (!bridge || mountedHostPath) {
    const hostPath = mountedHostPath ?? path.resolve(cwd, literalPath);
    const ancestorHostPath = ancestorPath
      ? bridge
        ? bridge.resolvePath({ filePath: ancestorPath, cwd }).hostPath
        : path.resolve(cwd, ancestorPath)
      : undefined;
    return pathExistsSync(hostPath) || (ancestorHostPath && pathExistsSync(ancestorHostPath))
      ? literalPath
      : filePath;
  }
  signal?.throwIfAborted();
  return bridge
    .stat({ filePath: literalPath, cwd, signal })
    .then(async (stat) =>
      stat || (ancestorPath && (await bridge.stat({ filePath: ancestorPath, cwd, signal })))
        ? literalPath
        : filePath,
    );
}
