import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { isNotFoundPathError, isPathInside } from "../infra/path-guards.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const HTTP_URL_RE = /^https?:\/\//i;
const DATA_URL_RE = /^data:/i;
const SANDBOX_CONTAINER_WORKDIR = "/workspace";

function normalizeUnicodeSpaces(str: string): string {
  return str.replace(UNICODE_SPACES, " ");
}

function normalizeAtPrefix(filePath: string): string {
  return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

function expandPath(filePath: string): string {
  const normalized = normalizeUnicodeSpaces(normalizeAtPrefix(filePath));
  if (normalized === "~") {
    return os.homedir();
  }
  if (normalized.startsWith("~/")) {
    return os.homedir() + normalized.slice(1);
  }
  return normalized;
}

function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  if (path.isAbsolute(expanded)) {
    return expanded;
  }
  return path.resolve(cwd, expanded);
}

export function resolveSandboxInputPath(filePath: string, cwd: string): string {
  return resolveToCwd(filePath, cwd);
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
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes sandbox root (${shortPath(rootResolved)}): ${params.filePath}`);
  }
  return { resolved, relative };
}

export async function assertSandboxPath(params: {
  filePath: string;
  cwd: string;
  root: string;
  allowFinalSymlink?: boolean;
}) {
  const resolved = resolveSandboxPath(params);
  await assertNoSymlinkEscape(resolved.relative, path.resolve(params.root), {
    allowFinalSymlink: params.allowFinalSymlink,
  });
  return resolved;
}

export function assertMediaNotDataUrl(media: string): void {
  const raw = media.trim();
  if (DATA_URL_RE.test(raw)) {
    throw new Error("data: URLs are not supported for media. Use buffer instead.");
  }
}

export async function resolveSandboxedMediaSource(params: {
  media: string;
  sandboxRoot: string;
}): Promise<string> {
  const raw = params.media.trim();
  if (!raw) {
    return raw;
  }
  if (HTTP_URL_RE.test(raw)) {
    return raw;
  }
  let candidate = raw;
  if (/^file:\/\//i.test(candidate)) {
    const workspaceMappedFromUrl = mapContainerWorkspaceFileUrl({
      fileUrl: candidate,
      sandboxRoot: params.sandboxRoot,
    });
    if (workspaceMappedFromUrl) {
      candidate = workspaceMappedFromUrl;
    } else {
      try {
        candidate = fileURLToPath(candidate);
      } catch {
        throw new Error(`Invalid file:// URL for sandboxed media: ${raw}`);
      }
    }
  }
  const containerWorkspaceMapped = mapContainerWorkspacePath({
    candidate,
    sandboxRoot: params.sandboxRoot,
  });
  if (containerWorkspaceMapped) {
    candidate = containerWorkspaceMapped;
  }
  const tmpMediaPath = await resolveAllowedTmpMediaPath({
    candidate,
    sandboxRoot: params.sandboxRoot,
  });
  if (tmpMediaPath) {
    return tmpMediaPath;
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
  // Sandbox paths are Linux-style (/workspace/*). Parse the URL path directly so
  // Windows hosts can still accept file:///workspace/... media references.
  const normalizedPathname = decodeURIComponent(parsed.pathname).replace(/\\/g, "/");
  if (
    normalizedPathname !== SANDBOX_CONTAINER_WORKDIR &&
    !normalizedPathname.startsWith(`${SANDBOX_CONTAINER_WORKDIR}/`)
  ) {
    return undefined;
  }
  return mapContainerWorkspacePath({
    candidate: normalizedPathname,
    sandboxRoot: params.sandboxRoot,
  });
}

function mapContainerWorkspacePath(params: {
  candidate: string;
  sandboxRoot: string;
}): string | undefined {
  const normalized = params.candidate.replace(/\\/g, "/");
  if (normalized === SANDBOX_CONTAINER_WORKDIR) {
    return path.resolve(params.sandboxRoot);
  }
  const prefix = `${SANDBOX_CONTAINER_WORKDIR}/`;
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
  const candidateIsAbsolute = path.isAbsolute(expandPath(params.candidate));
  if (!candidateIsAbsolute) {
    return undefined;
  }
  const resolved = path.resolve(resolveSandboxInputPath(params.candidate, params.sandboxRoot));
  const openClawTmpDir = path.resolve(resolvePreferredOpenClawTmpDir());
  if (!isPathInside(openClawTmpDir, resolved)) {
    return undefined;
  }
  await assertNoSymlinkEscape(path.relative(openClawTmpDir, resolved), openClawTmpDir);
  return resolved;
}

async function assertNoSymlinkEscape(
  relative: string,
  root: string,
  options?: { allowFinalSymlink?: boolean },
) {
  if (!relative) {
    return;
  }
  const rootReal = await tryRealpath(root);
  const parts = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (let idx = 0; idx < parts.length; idx += 1) {
    const part = parts[idx];
    const isLast = idx === parts.length - 1;
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        // Unlinking a symlink itself is safe even if it points outside the root. What we
        // must prevent is traversing through a symlink to reach targets outside root.
        if (options?.allowFinalSymlink && isLast) {
          return;
        }
        const target = await tryRealpath(current);
        if (!isPathInside(rootReal, target)) {
          throw new Error(
            `Symlink escapes sandbox root (${shortPath(rootReal)}): ${shortPath(current)}`,
          );
        }
        current = target;
      }
    } catch (err) {
      if (isNotFoundPathError(err)) {
        return;
      }
      throw err;
    }
  }
}

async function tryRealpath(value: string): Promise<string> {
  try {
    return await fs.realpath(value);
  } catch {
    return path.resolve(value);
  }
}

function shortPath(value: string) {
  if (value.startsWith(os.homedir())) {
    return `~${value.slice(os.homedir().length)}`;
  }
  return value;
}
