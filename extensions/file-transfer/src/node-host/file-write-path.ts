import fs from "node:fs/promises";
import path from "node:path";
import {
  canonicalPathFromExistingAncestor,
  FsSafeError,
  root,
} from "openclaw/plugin-sdk/security-runtime";
import {
  fileIdentity,
  matchesFileIdentity,
  type FileIdentity,
  type PathBinding,
} from "../shared/path-binding.js";

export type FileWriteError = {
  ok: false;
  code: string;
  message: string;
  canonicalPath?: string;
};

export function fileWriteError(
  code: string,
  message: string,
  canonicalPath?: string,
): FileWriteError {
  return { ok: false, code, message, ...(canonicalPath ? { canonicalPath } : {}) };
}

export async function canonicalTargetForSymlinkError(
  error: FsSafeError,
  targetPath: string,
): Promise<string | undefined> {
  // fs-safe may attach the canonical target to the error cause; when it does
  // not, resolve it here: realpath covers a final-component symlink, and the
  // existing-ancestor walk covers a symlinked parent of a missing leaf.
  const causeCanonical =
    error.cause &&
    typeof error.cause === "object" &&
    "canonicalPath" in error.cause &&
    typeof error.cause.canonicalPath === "string"
      ? error.cause.canonicalPath
      : undefined;
  if (causeCanonical) {
    return causeCanonical;
  }
  try {
    return await fs.realpath(targetPath);
  } catch {
    return await canonicalPathFromExistingAncestor(targetPath).catch(() => undefined);
  }
}

export function symlinkRedirectError(code: string, canonicalPath?: string): FileWriteError {
  return fileWriteError(
    code,
    "path traverses a symlink; refusing because followSymlinks=false (set plugins.entries.file-transfer.config.nodes.<node>.followSymlinks=true to allow, or update allowWritePaths to the canonical path)",
    canonicalPath,
  );
}

export function writeFsSafeError(error: FsSafeError, targetPath: string): FileWriteError {
  if (error.code === "symlink") {
    return fileWriteError(
      "SYMLINK_TARGET_DENIED",
      `path is a symlink; refusing to write through it: ${targetPath}`,
    );
  }
  if (error.code === "not-file") {
    return fileWriteError("IS_DIRECTORY", `path resolves to a directory: ${targetPath}`);
  }
  if (error.code === "already-exists") {
    return fileWriteError(
      "EXISTS_NO_OVERWRITE",
      `file already exists and overwrite is false: ${targetPath}`,
    );
  }
  return fileWriteError("WRITE_ERROR", error.message, targetPath);
}

export async function captureWriteBinding(
  canonicalTargetPath: string,
  targetIdentity?: FileIdentity,
): Promise<Extract<PathBinding, { kind: "write" }>> {
  let anchorPath = path.dirname(canonicalTargetPath);
  for (;;) {
    try {
      const stats = await fs.stat(anchorPath, { bigint: true });
      if (!stats.isDirectory()) {
        throw new Error(`write anchor is not a directory: ${anchorPath}`);
      }
      const anchor = fileIdentity(stats);
      return {
        kind: "write",
        anchorPath,
        anchorDevice: anchor.device,
        anchorInode: anchor.inode,
        ...(targetIdentity
          ? { targetDevice: targetIdentity.device, targetInode: targetIdentity.inode }
          : {}),
      };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(anchorPath);
      if (parent === anchorPath) {
        throw error;
      }
      anchorPath = parent;
    }
  }
}

export async function openBoundWriteRoot(input: {
  binding: Extract<PathBinding, { kind: "write" }>;
  canonicalTargetPath: string;
}): Promise<
  | { ok: true; anchorRoot: Awaited<ReturnType<typeof root>>; relativeTarget: string }
  | FileWriteError
> {
  let anchorRoot: Awaited<ReturnType<typeof root>>;
  try {
    anchorRoot = await root(input.binding.anchorPath);
    const anchorStats = await fs.stat(anchorRoot.rootReal, { bigint: true });
    if (
      !matchesFileIdentity(anchorStats, {
        device: input.binding.anchorDevice,
        inode: input.binding.anchorInode,
      })
    ) {
      throw new Error("write anchor changed");
    }
  } catch {
    return fileWriteError(
      "CANONICAL_PATH_CHANGED",
      "filesystem identity differs from the authorized target",
      input.canonicalTargetPath,
    );
  }
  const relativeTarget = path.relative(anchorRoot.rootReal, input.canonicalTargetPath);
  if (
    !relativeTarget ||
    path.isAbsolute(relativeTarget) ||
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${path.sep}`)
  ) {
    return fileWriteError("WRITE_ERROR", "write target is outside the authorized anchor");
  }
  return { ok: true, anchorRoot, relativeTarget };
}
