import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveMemoryHostAgentContextLimits,
  resolveMemoryHostAgentWorkspaceDir,
  resolveMemoryHostSearchPathConfig,
  type OpenClawConfig,
} from "./config-utils.js";
import { isExplicitExtraMarkdownFilePath } from "./explicit-extra-markdown.js";
import { isFileMissingError, isPathInside, root } from "./fs-utils.js";
import {
  isMemoryPath,
  matchesExtraMemoryPathEntry,
  normalizeExtraMemoryPathEntries,
} from "./internal.js";
import { getAgentWorkspaceAccess } from "./openclaw-runtime-workspace.js";
import {
  buildMemoryReadResult,
  DEFAULT_MEMORY_READ_LINES,
  type MemoryReadResult,
} from "./read-file-shared.js";
import { retryTransientMemoryRead } from "./read-retry.js";
import type { MemoryExtraPath } from "./types.js";

// Secure markdown memory-file reader for workspace and configured extra paths.

function memoryPathNotAllowed(): Error {
  return Object.assign(new Error("path is not an allowed Markdown memory file"), {
    code: "MEMORY_PATH_NOT_ALLOWED",
  });
}

/** Return true when a file vanished after path validation but before content read. */
function isFileDisappearedDuringReadError(err: unknown): boolean {
  return (
    isFileMissingError(err) ||
    Boolean(
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: unknown }).code === "path-mismatch",
    )
  );
}

/** Read a validated memory markdown file from workspace or configured extra paths. */
export async function readMemoryFile(params: {
  workspaceDir: string;
  extraPaths?: MemoryExtraPath[];
  relPath: string;
  from?: number;
  lines?: number;
  defaultLines?: number;
  maxChars?: number;
}): Promise<MemoryReadResult> {
  const rawPath = params.relPath.trim();
  if (!rawPath) {
    throw new Error("path required");
  }
  const absPath = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(params.workspaceDir, rawPath);
  const relPath = path.relative(params.workspaceDir, absPath).replace(/\\/g, "/");
  const inWorkspace = relPath.length > 0 && !relPath.startsWith("..") && !path.isAbsolute(relPath);
  const allowedWorkspace = inWorkspace && isMemoryPath(relPath);
  const notFound = (): MemoryReadResult => ({ status: "not_found", text: "", path: relPath });
  const readFromRoot = async (directory: string): Promise<MemoryReadResult> => {
    const filesystem = await root(directory, {
      hardlinks: "allow",
      maxBytes: Infinity,
      symlinks: allowedWorkspace ? "follow-parents-within-root" : "reject",
    });
    let content: string;
    try {
      content = (
        await retryTransientMemoryRead(async () => {
          try {
            return await filesystem.read(`./${path.relative(directory, absPath)}`);
          } catch (err) {
            // Keep read-time I/O errors visible to the existing retry predicate.
            if (
              err instanceof Error &&
              "code" in err &&
              err.code === "outside-workspace" &&
              err.cause instanceof Error &&
              "code" in err.cause &&
              !isFileMissingError(err.cause) &&
              err.cause.code !== "ELOOP"
            ) {
              throw err.cause;
            }
            throw err;
          }
        }, `read memory file ${absPath}`)
      ).buffer.toString("utf-8");
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
      if (code === "not-file") {
        throw new Error("path must be a regular file", { cause: err });
      }
      // Missing leaves return not_found; non-directory extra-path parents are not authorized.
      if (code !== "ENOTDIR" && isFileDisappearedDuringReadError(err)) {
        return notFound();
      }
      throw err;
    }
    return buildMemoryReadResult({
      content,
      relPath,
      from: params.from,
      lines: params.lines,
      defaultLines: params.defaultLines ?? DEFAULT_MEMORY_READ_LINES,
      maxChars: params.maxChars,
      suggestReadFallback: allowedWorkspace,
    });
  };
  if (allowedWorkspace) {
    if (!absPath.endsWith(".md")) {
      throw memoryPathNotAllowed();
    }
    try {
      return await readFromRoot(params.workspaceDir);
    } catch (err) {
      if (isFileMissingError(err)) {
        return notFound();
      }
      throw err;
    }
  }
  let additionalPathError: Error | undefined;
  if ((params.extraPaths?.length ?? 0) > 0) {
    const additionalPaths = normalizeExtraMemoryPathEntries(params.workspaceDir, params.extraPaths);
    for (const additionalPath of additionalPaths) {
      const matchesFile =
        absPath === additionalPath.path && isExplicitExtraMarkdownFilePath(absPath);
      const matchesDirectory =
        absPath.endsWith(".md") &&
        isPathInside(additionalPath.path, absPath) &&
        matchesExtraMemoryPathEntry(additionalPath, absPath);
      if (!matchesFile && !matchesDirectory) {
        continue;
      }
      try {
        const stat = await fs.lstat(additionalPath.path);
        if (stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory() && matchesDirectory) {
          return await readFromRoot(additionalPath.path);
        }
        if (stat.isFile() && matchesFile) {
          return await readFromRoot(path.dirname(additionalPath.path));
        }
      } catch (err) {
        const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
        if (
          err instanceof Error &&
          !isFileMissingError(err) &&
          code !== "symlink" &&
          code !== "outside-workspace"
        ) {
          // Another configured root may still authorize this file.
          additionalPathError ??= err;
        }
      }
    }
  }
  throw additionalPathError ?? memoryPathNotAllowed();
}

/** Resolve agent memory config and read one memory file for that agent. */
export async function readAgentMemoryFile(params: {
  cfg: OpenClawConfig;
  agentId: string;
  relPath: string;
  from?: number;
  lines?: number;
}): Promise<MemoryReadResult> {
  const settings = resolveMemoryHostSearchPathConfig(params.cfg, params.agentId);
  if (!settings) {
    throw new Error("memory search disabled");
  }
  const contextLimits = resolveMemoryHostAgentContextLimits(params.cfg, params.agentId);
  const workspaceDir = resolveMemoryHostAgentWorkspaceDir(params.cfg, params.agentId);
  const access = getAgentWorkspaceAccess(workspaceDir, "memoryFiles");
  return await (access?.memoryFiles?.readFile ?? readMemoryFile)({
    workspaceDir,
    extraPaths: settings.extraPaths,
    relPath: params.relPath,
    from: params.from,
    lines: params.lines,
    maxChars: contextLimits?.memoryGetMaxChars,
  });
}
