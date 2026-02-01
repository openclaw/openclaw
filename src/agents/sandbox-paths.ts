import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

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

export function resolveSandboxPath(params: {
  filePath: string;
  cwd: string;
  root: string;
  allowedPaths?: string[];
}): {
  resolved: string;
  relative: string;
  base: string;
} {
  const resolved = resolveToCwd(params.filePath, params.cwd);
  const rootResolved = path.resolve(params.root);
  const relative = path.relative(rootResolved, resolved);

  // Check if path is within the main root
  if (!relative || relative === "") {
    return { resolved, relative: "", base: rootResolved };
  }
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return { resolved, relative, base: rootResolved };
  }

  // Path escapes main root - check allowedPaths
  if (params.allowedPaths?.length) {
    for (const allowedPath of params.allowedPaths) {
      const allowedResolved = path.resolve(allowedPath);
      const relativeToAllowed = path.relative(allowedResolved, resolved);
      if (
        relativeToAllowed === "" ||
        (!relativeToAllowed.startsWith("..") && !path.isAbsolute(relativeToAllowed))
      ) {
        return { resolved, relative: relativeToAllowed, base: allowedResolved };
      }
    }
  }

  throw new Error(`Path escapes sandbox root (${shortPath(rootResolved)}): ${params.filePath}`);
}

export async function assertSandboxPath(params: {
  filePath: string;
  cwd: string;
  root: string;
  allowedPaths?: string[];
}) {
  const resolved = resolveSandboxPath(params);
  await assertNoSymlink(resolved.relative, resolved.base);
  return resolved;
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
