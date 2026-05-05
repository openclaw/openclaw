import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const HTTP_URL_RE = /^https?:\/\//i;
const DATA_URL_RE = /^data:/i;

function normalizeUnicodeSpaces(str: string): string {
  return str.replace(UNICODE_SPACES, " ");
}

function expandPath(filePath: string): string {
  const normalized = normalizeUnicodeSpaces(filePath);
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

function resolveLegacyOpenClawAlias(resolved: string, rootResolved: string): string {
  if (!path.isAbsolute(resolved)) {
    return resolved;
  }
  const rootParts = rootResolved.split(path.sep).filter(Boolean);
  const openclawIndex = rootParts.indexOf(".openclaw");
  if (openclawIndex === -1) {
    return resolved;
  }
  const suffixParts = rootParts.slice(openclawIndex);
  if (suffixParts.length === 0) {
    return resolved;
  }
  const legacyPrefix = path.posix.join("/home/node", ...suffixParts);
  const normalizedResolved = resolved.split(path.sep).join(path.posix.sep);
  if (normalizedResolved === legacyPrefix) {
    return rootResolved;
  }
  const legacyDirPrefix = `${legacyPrefix}/`;
  if (!normalizedResolved.startsWith(legacyDirPrefix)) {
    return resolved;
  }
  const relative = normalizedResolved.slice(legacyDirPrefix.length);
  if (!relative) {
    return rootResolved;
  }
  // Keep legacy Docker-era ~/.openclaw paths working when the sandbox root is
  // the same host-backed .openclaw tree mounted from macOS.
  return path.join(rootResolved, ...relative.split("/"));
}

export function resolveSandboxPath(params: { filePath: string; cwd: string; root: string }): {
  resolved: string;
  relative: string;
} {
  const rootResolved = path.resolve(params.root);
  const resolved = resolveLegacyOpenClawAlias(
    resolveToCwd(params.filePath, params.cwd),
    rootResolved,
  );
  const relative = path.relative(rootResolved, resolved);
  if (!relative || relative === "") {
    return { resolved, relative: "" };
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes sandbox root (${shortPath(rootResolved)}): ${params.filePath}`);
  }
  return { resolved, relative };
}

export async function assertSandboxPath(params: { filePath: string; cwd: string; root: string }) {
  const resolved = resolveSandboxPath(params);
  await assertNoSymlink(resolved.relative, path.resolve(params.root));
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
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      throw new Error(`Invalid file:// URL for sandboxed media: ${raw}`);
    }
  }
  const resolved = await assertSandboxPath({
    filePath: candidate,
    cwd: params.sandboxRoot,
    root: params.sandboxRoot,
  });
  return resolved.resolved;
}

async function assertNoSymlink(relative: string, root: string) {
  if (!relative) {
    return;
  }
  const parts = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Symlink not allowed in sandbox path: ${current}`);
      }
    } catch (err) {
      const anyErr = err as { code?: string };
      if (anyErr.code === "ENOENT") {
        return;
      }
      throw err;
    }
  }
}

function shortPath(value: string) {
  if (value.startsWith(os.homedir())) {
    return `~${value.slice(os.homedir().length)}`;
  }
  return value;
}
