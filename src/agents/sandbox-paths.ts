import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveStateDir, resolveLegacyStateDirs } from "../config/paths.js";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const HTTP_URL_RE = /^https?:\/\//i;
const DATA_URL_RE = /^data:/i;

/**
 * Well-known directories that contain secrets (API keys, tokens, credentials)
 * and must never be accessible from within the sandbox, even when they fall
 * inside the sandbox root.
 *
 * Paths are resolved at call time so environment overrides are respected.
 */
let _sensitivePaths: string[] | null = null;

/** @internal Reset the cached sensitive paths (for testing only). */
export function _resetSensitivePathsCache(): void {
  _sensitivePaths = null;
}

function resolveSensitivePaths(): string[] {
  if (_sensitivePaths) return _sensitivePaths;
  const home = os.homedir();
  _sensitivePaths = [
    // OpenClaw state dir (contains openclaw.json with API keys, credentials/, sessions/)
    resolveStateDir(),
    // Legacy state dirs (.clawdbot, .moldbot, .moltbot)
    ...resolveLegacyStateDirs(),
    // SSH keys
    path.join(home, ".ssh"),
    // GPG keys
    path.join(home, ".gnupg"),
    // AWS credentials
    path.join(home, ".aws"),
    // Google Cloud credentials
    path.join(home, ".config", "gcloud"),
  ].map((p) => path.resolve(p));
  return _sensitivePaths;
}

/**
 * Check whether a resolved path falls inside any sensitive directory.
 * Uses the same `expandPath` normalizer as the sandbox resolver to prevent
 * normalization mismatches (e.g. Unicode space tricks).
 */
export function isSensitivePath(resolvedPath: string): { sensitive: boolean; directory?: string } {
  const normalized = path.resolve(resolvedPath);
  for (const dir of resolveSensitivePaths()) {
    const relative = path.relative(dir, normalized);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return { sensitive: true, directory: shortPath(dir) };
    }
  }
  return { sensitive: false };
}

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

export function resolveSandboxInputPath(filePath: string, cwd: string): string {
  return resolveToCwd(filePath, cwd);
}

export function resolveSandboxPath(params: {
  filePath: string;
  cwd: string;
  root: string;
  /** Skip the sensitive-path check (e.g. for internal/elevated operations). */
  skipSensitiveCheck?: boolean;
}): {
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

  // Block access to sensitive directories (API keys, credentials, SSH keys)
  // even when they fall within the sandbox root.
  if (!params.skipSensitiveCheck) {
    const check = isSensitivePath(resolved);
    if (check.sensitive) {
      throw new Error(
        `Access denied: path targets a sensitive directory (${check.directory}): ${params.filePath}`,
      );
    }
  }

  return { resolved, relative };
}

export async function assertSandboxPath(params: {
  filePath: string;
  cwd: string;
  root: string;
  allowFinalSymlink?: boolean;
  skipSensitiveCheck?: boolean;
}) {
  const resolved = resolveSandboxPath(params);
  await assertNoSymlinkEscape(resolved.relative, path.resolve(params.root), {
    allowFinalSymlink: params.allowFinalSymlink,
  });

  // Post-symlink sensitive-path check: resolve the real path (following symlinks)
  // and verify the *target* isn't sensitive. This closes the symlink bypass where
  // ~/workspace/link -> ~/.openclaw/ would pass the sync check on the link path
  // but actually access credentials via the symlink target.
  if (!params.skipSensitiveCheck) {
    const realPath = await tryRealpath(resolved.resolved);
    const check = isSensitivePath(realPath);
    if (check.sensitive) {
      throw new Error(
        `Access denied: path resolves to a sensitive directory (${check.directory}): ${params.filePath}`,
      );
    }
  }

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
      const anyErr = err as { code?: string };
      if (anyErr.code === "ENOENT") {
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

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  if (!relative || relative === "") {
    return true;
  }
  return !(relative.startsWith("..") || path.isAbsolute(relative));
}

function shortPath(value: string) {
  if (value.startsWith(os.homedir())) {
    return `~${value.slice(os.homedir().length)}`;
  }
  return value;
}
