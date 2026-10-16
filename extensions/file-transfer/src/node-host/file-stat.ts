import fs from "node:fs";
import path from "node:path";
import { openRootFile } from "openclaw/plugin-sdk/file-access-runtime";
import { fileIdentity, matchesFileIdentity, readPathBinding } from "../shared/path-binding.js";
import {
  createReadErrorClassifier,
  readAbsolutePath,
  rejectCanonicalPathChange,
  resolveCanonicalReadPath,
} from "./path-errors.js";

type FileStatParams = {
  path?: unknown;
  followSymlinks?: unknown;
  preflightOnly?: unknown;
  expectedCanonicalPath?: unknown;
  expectedBinding?: unknown;
};

const classifyError = createReadErrorClassifier({
  ENOENT: "NOT_FOUND",
  ENOTDIR: "NOT_FOUND",
  EACCES: "PERMISSION_DENIED",
  EPERM: "PERMISSION_DENIED",
} as const);

export async function handleFileStat(params: FileStatParams) {
  const requestedPath = readAbsolutePath(params.path);
  if (typeof requestedPath !== "string") {
    return requestedPath;
  }
  const canonicalPath = await resolveCanonicalReadPath({
    requestedPath,
    followSymlinks: params.followSymlinks === true,
    classifyError,
    notFoundMessage: "path not found",
  });
  if (typeof canonicalPath !== "string") {
    return canonicalPath;
  }
  const changed = rejectCanonicalPathChange(params.expectedCanonicalPath, canonicalPath);
  if (changed) {
    return changed;
  }

  try {
    // The initial stat selects an allowed type; returned metadata and identity
    // come from the same descriptor opened and checked by fs-safe.
    const candidate = await fs.promises.lstat(canonicalPath);
    if (!candidate.isFile() && !candidate.isDirectory()) {
      return {
        ok: false as const,
        code: "UNSUPPORTED_FILE_TYPE",
        message: "only regular files and directories are supported",
        canonicalPath,
      };
    }
    const opened = await openRootFile({
      absolutePath: canonicalPath,
      rootPath: path.dirname(canonicalPath),
      boundaryLabel: "file.stat",
      allowedType: candidate.isDirectory() ? "directory" : "file",
      rejectHardlinks: false,
    });
    if (!opened.ok) {
      return {
        ok: false as const,
        code: classifyError(opened.error),
        message: "could not open the metadata target",
        canonicalPath,
      };
    }
    try {
      const openedPathChange = rejectCanonicalPathChange(canonicalPath, opened.path);
      if (openedPathChange) {
        return openedPathChange;
      }
      const stats = fs.fstatSync(opened.fd, { bigint: true });
      const expected = readPathBinding(params.expectedBinding);
      if (
        params.expectedBinding !== undefined &&
        (expected?.kind !== "existing" || !matchesFileIdentity(stats, expected))
      ) {
        return {
          ok: false as const,
          code: "CANONICAL_PATH_CHANGED",
          message: "filesystem identity differs from the authorized target",
          canonicalPath,
        };
      }
      return {
        ok: true as const,
        path: opened.path,
        type: stats.isDirectory() ? ("directory" as const) : ("file" as const),
        size: Number(stats.size),
        mtimeMs: Number(stats.mtimeNs) / 1_000_000,
        binding: { kind: "existing" as const, ...fileIdentity(stats) },
        ...(params.preflightOnly === true ? { preflightOnly: true } : {}),
      };
    } finally {
      fs.closeSync(opened.fd);
    }
  } catch (error) {
    return {
      ok: false as const,
      code: classifyError(error),
      message: "could not read file metadata",
      canonicalPath,
    };
  }
}
