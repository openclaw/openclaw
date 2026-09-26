/**
 * Sandbox input path normalization and boundary checks.
 *
 * Handles host paths, file URLs, temporary media paths, and workspace root assertions.
 */
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import {
  assertNoPathAliasEscape,
  assertNoWindowsNetworkPath,
  hasEncodedFileUrlSeparator,
  resolvePathPrefixSync,
  safeFileURLToPath,
  type PathAliasPolicy,
} from "@openclaw/fs-safe/advanced";
import { isWindowsDrivePath } from "@openclaw/fs-safe/archive";
import { isPassThroughRemoteMediaSource } from "@openclaw/media-core/media-source-url";
import { isPathInside } from "../infra/path-guards.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { resolveConfigDir, shortenHomePath } from "../utils.js";

const DATA_URL_RE = /^data:/i;
const SANDBOX_CONTAINER_WORKDIR = "/workspace";
const MANAGED_MEDIA_SUBDIRS = new Set(["outbound"]);

/** Consume one file-reference prefix while preserving remaining literal @ bytes. */
export function normalizeFileReferencePrefix(filePath: string): string {
  const referenced = filePath.startsWith("@") ? filePath.slice(1) : filePath;
  // Paths cross multiple tool/guard/bridge resolvers. Escape the remaining
  // prefix so later resolution cannot reinterpret the selected filename.
  return referenced.startsWith("@") ? `./${referenced}` : referenced;
}

export function normalizeSandboxInputPath(filePath: string): string {
  const normalized = normalizeFileReferencePrefix(filePath);
  if (normalized === "~") {
    return os.homedir();
  }
  if (normalized.startsWith("~/")) {
    return os.homedir() + normalized.slice(1);
  }
  return normalized;
}

/** True when the path is absolute for the current platform or a Windows drive path (e.g. C:\\...), even if path.isAbsolute is false under POSIX rules. */
function hostPathLooksAbsolute(expanded: string): boolean {
  return path.isAbsolute(expanded) || isWindowsDrivePath(expanded);
}

export function resolveSandboxInputPath(filePath: string, cwd: string): string {
  const expanded = normalizeSandboxInputPath(filePath);
  // Drive-letter paths first: on Unix path.isAbsolute is false for C:/...; on Windows we still normalize.
  if (isWindowsDrivePath(expanded)) {
    return path.win32.normalize(expanded);
  }
  if (path.isAbsolute(expanded)) {
    return expanded;
  }
  return path.resolve(cwd, expanded);
}

export function resolveSandboxPath(params: { filePath: string; cwd: string; root: string }): {
  resolved: string;
  relative: string;
} {
  const resolved = resolveSandboxInputPath(params.filePath, params.cwd);
  const rootResolved = path.resolve(params.root);
  const relative = path.relative(rootResolved, resolved);
  if (!relative || relative === "") {
    return { resolved, relative: "" };
  }
  if (
    relative === ".." ||
    relative.startsWith("../") ||
    relative.startsWith("..\\") ||
    path.isAbsolute(relative) ||
    isWindowsDrivePath(relative)
  ) {
    throw markHostRootEscape(
      new Error(`Path escapes sandbox root (${shortenHomePath(rootResolved)}): ${params.filePath}`),
    );
  }
  return { resolved, relative };
}

const HOST_ROOT_ESCAPE = Symbol.for("openclaw.hostRootEscape");

/**
 * Tag a rejection as coming from the host workspace root. Sandbox filesystem bridges
 * enforce their own mount boundary and leave their rejections untagged, so callers can
 * tell the two apart without reading the message text.
 */
export function markHostRootEscape<E>(error: E): E {
  try {
    if (error instanceof Error && Object.isExtensible(error)) {
      Object.defineProperty(error, HOST_ROOT_ESCAPE, { value: true });
    }
  } catch {
    // Diagnostic annotation must never replace the original rejection.
  }
  return error;
}

/** True when a rejection came from the host workspace root rather than a container mount. */
export function isHostRootEscapeError(error: unknown): error is Error {
  try {
    return error instanceof Error && Reflect.get(error, HOST_ROOT_ESCAPE) === true;
  } catch {
    return false;
  }
}

function rethrowHostPathAliasError(error: unknown): never {
  // Only the direct host validator calls this. fs-safe reports escape kinds as
  // messages; bridge errors never enter this classifier. Other alias and I/O
  // failures must keep their own explanation.
  if (isPathBoundaryEscapeError(error, "sandbox root")) {
    throw markHostRootEscape(error);
  }
  throw error;
}

/** Classify fs-safe's untyped escape errors only at a known validator boundary. */
export function isPathBoundaryEscapeError(
  error: unknown,
  boundary: "sandbox root" | "workspace root",
): error is Error {
  return (
    error instanceof Error &&
    /^(?:Path escapes|Path resolves outside|Symlink escapes) (sandbox root|workspace root) \(/.exec(
      error.message,
    )?.[1] === boundary
  );
}

async function resolveRawPathViaExistingAncestor(rawPath: string): Promise<string> {
  const { existingPath, unresolvedSegments } = resolvePathPrefixSync(rawPath);
  return path.resolve(existingPath, ...unresolvedSegments);
}

export async function assertSandboxPath(params: {
  filePath: string;
  cwd: string;
  root: string;
  allowFinalSymlinkForUnlink?: boolean;
  allowFinalHardlinkForUnlink?: boolean;
}) {
  const root = path.resolve(params.root);
  const cwd = path.resolve(params.cwd);
  let resolutionCwd = cwd;
  let filePath = params.filePath;
  const expanded = normalizeSandboxInputPath(filePath);
  if (process.platform !== "win32" && !isWindowsDrivePath(expanded)) {
    const rootPromise = resolveRawPathViaExistingAncestor(root);
    const [rootCanonical, canonicalCwd] = await Promise.all([
      rootPromise,
      cwd === root ? rootPromise : resolveRawPathViaExistingAncestor(cwd),
    ]);
    resolutionCwd = path.resolve(root, path.relative(rootCanonical, canonicalCwd));
    // Only caller-owned prefixes may change spelling. Canonicalizing the input
    // itself would admit unrelated external links pointing into the workspace.
    const prefixes: [string, string][] = [
      [cwd, resolutionCwd],
      [root, root],
      [rootCanonical, root],
    ];
    if (path.isAbsolute(expanded) && isPathInside(rootCanonical, canonicalCwd)) {
      const rootAlias = path.resolve(cwd, path.relative(canonicalCwd, rootCanonical));
      // Cwd may itself link deeper into the root; its ancestors are trusted only
      // after proving the candidate has the recorded root's canonical identity.
      if (
        !prefixes.some(([prefix]) => prefix === rootAlias) &&
        (await resolveRawPathViaExistingAncestor(rootAlias)) === rootCanonical
      ) {
        prefixes.push([rootAlias, root]);
      }
    }
    for (const [prefix, replacement] of prefixes.toSorted((a, b) => b[0].length - a[0].length)) {
      if (expanded === prefix) {
        filePath = replacement;
        break;
      }
      const prefixWithSeparator = prefix.endsWith(path.sep) ? prefix : `${prefix}${path.sep}`;
      if (expanded.startsWith(prefixWithSeparator)) {
        // Preserve raw '..' and trailing separators for the path guards below.
        const separator = replacement.endsWith(path.sep) ? "" : path.sep;
        filePath = `${replacement}${separator}${expanded.slice(prefixWithSeparator.length)}`;
        break;
      }
    }
  }
  const resolved = resolveSandboxPath({ filePath, cwd: resolutionCwd, root });
  const rawPath = normalizeSandboxInputPath(filePath);
  const policy: PathAliasPolicy = {
    allowFinalSymlinkForUnlink: params.allowFinalSymlinkForUnlink,
    allowFinalHardlinkForUnlink: params.allowFinalHardlinkForUnlink,
  };
  // Callers retain the lexical result; both it and POSIX symlink/.. traversal must be safe.
  const paths = new Set([resolved.resolved]);
  if (process.platform !== "win32") {
    paths.add(path.isAbsolute(rawPath) ? rawPath : `${resolutionCwd}${path.sep}${rawPath}`);
  }
  for (const absolutePath of paths) {
    await assertNoPathAliasEscape({
      absolutePath,
      rootPath: root,
      boundaryLabel: "sandbox root",
      policy,
    }).catch(rethrowHostPathAliasError);
  }
  return resolved;
}

export function assertMediaNotDataUrl(media: string): void {
  const raw = media.trim();
  if (DATA_URL_RE.test(raw)) {
    throw new Error("data: URLs are not supported for media. Use buffer instead.");
  }
}

export function resolveManagedMediaRoot(candidate: string): string | undefined {
  const expanded = normalizeSandboxInputPath(candidate);
  if (!hostPathLooksAbsolute(expanded)) {
    return undefined;
  }
  const mediaRoot = path.join(resolveConfigDir(), "media");
  const resolvedMediaRoot = path.resolve(mediaRoot);
  const resolvedExpanded = path.resolve(expanded);
  if (
    resolvedExpanded === resolvedMediaRoot ||
    !isPathInside(resolvedMediaRoot, resolvedExpanded)
  ) {
    return undefined;
  }
  const relative = path.relative(resolvedMediaRoot, resolvedExpanded);
  const firstSegment = relative.split(path.sep)[0] ?? "";
  return MANAGED_MEDIA_SUBDIRS.has(firstSegment) || firstSegment.startsWith("tool-")
    ? path.join(resolvedMediaRoot, firstSegment)
    : undefined;
}

export async function resolveAllowedManagedMediaPath(
  candidate: string,
): Promise<string | undefined> {
  const expanded = normalizeSandboxInputPath(candidate);
  if (!resolveManagedMediaRoot(expanded)) {
    return undefined;
  }
  const resolved = path.resolve(expanded);
  const managedMediaRoot = path.resolve(resolveConfigDir(), "media");
  await assertNoPathAliasEscape({
    absolutePath: resolved,
    rootPath: managedMediaRoot,
    boundaryLabel: "managed media root",
  });
  return resolved;
}

export async function resolveSandboxedMediaSource(params: {
  media: string;
  sandboxRoot: string;
  containerWorkdir?: string;
}): Promise<string> {
  const raw = params.media.trim();
  if (!raw) {
    return raw;
  }
  if (isPassThroughRemoteMediaSource(raw)) {
    return raw;
  }
  const normalizedContainerWorkdir = path.posix.normalize(
    (params.containerWorkdir ?? SANDBOX_CONTAINER_WORKDIR).replace(/\\/g, "/"),
  );
  const containerWorkdir = normalizedContainerWorkdir.replace(/\/+$/, "") || "/";
  let candidate = raw;
  if (/^file:/i.test(candidate)) {
    const workspaceMappedFromUrl = mapContainerWorkspaceFileUrl({
      fileUrl: candidate,
      sandboxRoot: params.sandboxRoot,
      containerWorkdir,
    });
    if (workspaceMappedFromUrl) {
      candidate = workspaceMappedFromUrl;
    } else {
      try {
        candidate = safeFileURLToPath(candidate);
      } catch (err) {
        throw new Error(`Invalid file:// URL for sandboxed media: ${(err as Error).message}`, {
          cause: err,
        });
      }
    }
  }
  const containerWorkspaceMapped = mapContainerWorkspacePath({
    candidate,
    sandboxRoot: params.sandboxRoot,
    containerWorkdir,
  });
  if (containerWorkspaceMapped) {
    candidate = containerWorkspaceMapped;
  }
  assertNoWindowsNetworkPath(candidate, "Sandbox media path");
  const tmpMediaPath = await resolveAllowedTmpMediaPath({
    candidate,
    sandboxRoot: params.sandboxRoot,
  });
  if (tmpMediaPath) {
    return tmpMediaPath;
  }
  const managedMediaPath = await resolveAllowedManagedMediaPath(candidate);
  if (managedMediaPath) {
    return managedMediaPath;
  }
  const sandboxResult = await assertSandboxPath({
    filePath: candidate,
    cwd: params.sandboxRoot,
    root: params.sandboxRoot,
  });
  return sandboxResult.resolved;
}

function mapContainerWorkspaceFileUrl(params: {
  fileUrl: string;
  sandboxRoot: string;
  containerWorkdir: string;
}): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(params.fileUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "file:") {
    return undefined;
  }
  const host = parsed.hostname.trim().toLowerCase();
  if (host && host !== "localhost") {
    return undefined;
  }
  if (hasEncodedFileUrlSeparator(parsed.pathname)) {
    return undefined;
  }
  // Backend workdirs are container paths; parse the URL directly so Windows hosts
  // can still map Linux-style file URLs to their actual sandbox workspace.
  let normalizedPathname: string;
  try {
    normalizedPathname = decodeURIComponent(parsed.pathname).replace(/\\/g, "/");
  } catch {
    return undefined;
  }
  return mapContainerWorkspacePath({
    candidate: normalizedPathname,
    sandboxRoot: params.sandboxRoot,
    containerWorkdir: params.containerWorkdir,
  });
}

function mapContainerWorkspacePath(params: {
  candidate: string;
  sandboxRoot: string;
  containerWorkdir: string;
}): string | undefined {
  const normalized = params.candidate.replace(/\\/g, "/");
  if (normalized === params.containerWorkdir) {
    return path.resolve(params.sandboxRoot);
  }
  const prefix = params.containerWorkdir === "/" ? "/" : `${params.containerWorkdir}/`;
  if (!normalized.startsWith(prefix)) {
    return undefined;
  }
  const rel = normalized.slice(prefix.length);
  if (!rel) {
    return path.resolve(params.sandboxRoot);
  }
  return path.resolve(params.sandboxRoot, ...rel.split("/").filter(Boolean));
}

async function resolveAllowedTmpMediaPath(params: {
  candidate: string;
  sandboxRoot: string;
}): Promise<string | undefined> {
  const candidateIsAbsolute = hostPathLooksAbsolute(normalizeSandboxInputPath(params.candidate));
  if (!candidateIsAbsolute) {
    return undefined;
  }
  const resolved = path.resolve(resolveSandboxInputPath(params.candidate, params.sandboxRoot));
  const openClawTmpDir = path.resolve(resolvePreferredOpenClawTmpDir());
  if (!isPathInside(openClawTmpDir, resolved)) {
    return undefined;
  }
  await assertNoPathAliasEscape({
    absolutePath: resolved,
    rootPath: openClawTmpDir,
    boundaryLabel: "tmp root",
  });
  return resolved;
}
